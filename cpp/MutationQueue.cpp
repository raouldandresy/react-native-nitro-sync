#include "MutationQueue.h"

#include <sqlite3.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

namespace nitrosync {
namespace {

constexpr const char* kSchema = R"SQL(
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED', 'REJECTED')),
  retry_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sync_queue_status_timestamp ON sync_queue(status, timestamp);
CREATE TABLE IF NOT EXISTS sync_records (
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (table_name, record_id)
);
)SQL";
constexpr int kCurrentSchemaVersion = 4;

void checkSqlite(int result, sqlite3* database, const char* context) {
  if (result != SQLITE_OK && result != SQLITE_DONE && result != SQLITE_ROW) {
    const char* message = database == nullptr ? "SQLite error" : sqlite3_errmsg(database);
    throw std::runtime_error(std::string(context) + ": " + message);
  }
}

std::string columnText(sqlite3_stmt* statement, int column) {
  const unsigned char* text = sqlite3_column_text(statement, column);
  return text == nullptr ? std::string() : reinterpret_cast<const char*>(text);
}

struct StatementDeleter {
  void operator()(sqlite3_stmt* statement) const {
    if (statement != nullptr) {
      sqlite3_finalize(statement);
    }
  }
};

using Statement = std::unique_ptr<sqlite3_stmt, StatementDeleter>;

std::string quoteJsonString(const std::string& value) {
  static constexpr char kHex[] = "0123456789abcdef";
  std::string escaped;
  escaped.reserve(value.size() + 2);
  escaped.push_back('"');
  for (const unsigned char character : value) {
    switch (character) {
      case '"': escaped.append("\\\""); break;
      case '\\': escaped.append("\\\\"); break;
      case '\b': escaped.append("\\b"); break;
      case '\f': escaped.append("\\f"); break;
      case '\n': escaped.append("\\n"); break;
      case '\r': escaped.append("\\r"); break;
      case '\t': escaped.append("\\t"); break;
      default:
        if (character < 0x20) {
          escaped.append("\\u00");
          escaped.push_back(kHex[(character >> 4) & 0x0f]);
          escaped.push_back(kHex[character & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(character));
        }
    }
  }
  escaped.push_back('"');
  return escaped;
}

Statement prepare(sqlite3* database, const char* sql, const char* context) {
  sqlite3_stmt* statement = nullptr;
  checkSqlite(sqlite3_prepare_v2(database, sql, -1, &statement, nullptr), database, context);
  return Statement(statement);
}

}  // namespace

MutationQueue::MutationQueue(std::string databasePath) : databasePath_(std::move(databasePath)) {}

MutationQueue::~MutationQueue() {
  if (database_ != nullptr) {
    sqlite3_close_v2(database_);
  }
}

void MutationQueue::initialize() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (database_ != nullptr) {
    recoverSyncing();
    return;
  }
  checkSqlite(sqlite3_open(databasePath_.c_str(), &database_), database_, "Opening database");
  sqlite3_busy_timeout(database_, 5000);
  try {
    execute(kSchema);
    Statement versionStatement = prepare(database_, "PRAGMA user_version", "Reading schema version");
    const int versionResult = sqlite3_step(versionStatement.get());
    checkSqlite(versionResult, database_, "Reading schema version");
    int schemaVersion = sqlite3_column_int(versionStatement.get(), 0);
    versionStatement.reset();
    if (schemaVersion > kCurrentSchemaVersion) {
      throw std::runtime_error("Database schema version is newer than this Nitro Sync build");
    }
    if (schemaVersion < 1) {
      execute("PRAGMA user_version = 1;");
      schemaVersion = 1;
    }
    if (schemaVersion < 2) {
      execute("CREATE INDEX IF NOT EXISTS sync_records_deleted_updated_at "
              "ON sync_records(table_name, deleted, updated_at);");
      execute("PRAGMA user_version = 2;");
      schemaVersion = 2;
    }
    if (schemaVersion < 3) {
      execute("BEGIN IMMEDIATE TRANSACTION;");
      try {
        execute("DROP INDEX IF EXISTS sync_queue_status_timestamp;");
        execute("CREATE TABLE sync_queue_v3 ("
                "id TEXT PRIMARY KEY NOT NULL,"
                "table_name TEXT NOT NULL,"
                "operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),"
                "payload TEXT NOT NULL CHECK (json_valid(payload)),"
                "timestamp INTEGER NOT NULL,"
                "status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED', 'REJECTED')),"
                "retry_count INTEGER NOT NULL DEFAULT 0);");
        execute("INSERT INTO sync_queue_v3 (id, table_name, operation, payload, timestamp, status, retry_count) "
                "SELECT id, table_name, operation, payload, timestamp, status, retry_count FROM sync_queue;");
        execute("DROP TABLE sync_queue;");
        execute("ALTER TABLE sync_queue_v3 RENAME TO sync_queue;");
        execute("CREATE INDEX sync_queue_status_timestamp ON sync_queue(status, timestamp);");
        execute("PRAGMA user_version = 3;");
        execute("COMMIT;");
      } catch (...) {
        try {
          execute("ROLLBACK;");
        } catch (...) {
        }
        throw;
      }
    }
    if (schemaVersion < 4) {
      execute("BEGIN IMMEDIATE TRANSACTION;");
      try {
        execute("ALTER TABLE sync_queue ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;");
        execute("PRAGMA user_version = 4;");
        execute("COMMIT;");
      } catch (...) {
        try {
          execute("ROLLBACK;");
        } catch (...) {
        }
        throw;
      }
    }
    recoverSyncing();
  } catch (...) {
    sqlite3_close_v2(database_);
    database_ = nullptr;
    throw;
  }
}

void MutationQueue::execute(const char* sql) const {
  char* error = nullptr;
  const int result = sqlite3_exec(database_, sql, nullptr, nullptr, &error);
  if (result != SQLITE_OK) {
    const std::string message = error == nullptr ? "SQLite error" : error;
    sqlite3_free(error);
    throw std::runtime_error(message);
  }
}

void MutationQueue::recoverSyncing() {
  execute("UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING';");
}

void MutationQueue::enqueue(const Mutation& mutation) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char* sql = "INSERT INTO sync_queue "
                    "(id, table_name, operation, payload, timestamp, status, retry_count, schema_version) "
                    "VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?) "
                    "ON CONFLICT(id) DO NOTHING";
  Statement statement = prepare(database_, sql, "Preparing enqueue");
  sqlite3_bind_text(statement.get(), 1, mutation.id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 2, mutation.tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 3, operationToSql(mutation.operation), -1, SQLITE_STATIC);
  sqlite3_bind_text(statement.get(), 4, mutation.payload.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.get(), 5, mutation.timestamp);
  sqlite3_bind_int(statement.get(), 6, mutation.schemaVersion);
  checkSqlite(sqlite3_step(statement.get()), database_, "Enqueue mutation");
}

std::vector<Mutation> MutationQueue::claimPending(std::size_t limit) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<Mutation> mutations;
  execute("BEGIN IMMEDIATE TRANSACTION;");
  try {
    const char* selectSql = "SELECT id, table_name, operation, payload, timestamp, schema_version, status, retry_count "
                            "FROM sync_queue WHERE status IN ('PENDING', 'FAILED') "
                            "ORDER BY timestamp ASC LIMIT ?";
    Statement statement = prepare(database_, selectSql, "Preparing claim");
    sqlite3_bind_int64(statement.get(), 1, static_cast<sqlite3_int64>(limit));
    while (true) {
      const int step = sqlite3_step(statement.get());
      if (step == SQLITE_DONE) {
        break;
      }
      if (step != SQLITE_ROW) {
        checkSqlite(step, database_, "Claiming mutations");
        break;
      }
      mutations.push_back({
          columnText(statement.get(), 0),
          columnText(statement.get(), 1),
          operationFromSql(columnText(statement.get(), 2).c_str()),
          columnText(statement.get(), 3),
          sqlite3_column_int64(statement.get(), 4),
          sqlite3_column_int(statement.get(), 5),
          statusFromSql(columnText(statement.get(), 6).c_str()),
          sqlite3_column_int(statement.get(), 7)});
    }
    statement.reset();
    for (const Mutation& mutation : mutations) {
      Statement update = prepare(database_, "UPDATE sync_queue SET status = 'SYNCING' WHERE id = ?", "Preparing claim update");
      sqlite3_bind_text(update.get(), 1, mutation.id.c_str(), -1, SQLITE_TRANSIENT);
      checkSqlite(sqlite3_step(update.get()), database_, "Claiming mutation");
    }
    execute("COMMIT;");
  } catch (...) {
    try {
      execute("ROLLBACK;");
    } catch (...) {
    }
    throw;
  }
  for (Mutation& mutation : mutations) {
    mutation.status = MutationStatus::Syncing;
  }
  return mutations;
}

void MutationQueue::updateStatus(const std::string& id, MutationStatus status, bool incrementRetry) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char* sql = incrementRetry
      ? "UPDATE sync_queue SET status = ?, retry_count = retry_count + 1 WHERE id = ?"
      : "UPDATE sync_queue SET status = ? WHERE id = ?";
  Statement statement = prepare(database_, sql, "Preparing status update");
  const char* statusText = status == MutationStatus::Pending ? "PENDING"
      : status == MutationStatus::Syncing ? "SYNCING"
      : status == MutationStatus::Rejected ? "REJECTED" : "FAILED";
  sqlite3_bind_text(statement.get(), 1, statusText, -1, SQLITE_STATIC);
  sqlite3_bind_text(statement.get(), 2, id.c_str(), -1, SQLITE_TRANSIENT);
  checkSqlite(sqlite3_step(statement.get()), database_, "Updating mutation status");
}

void MutationQueue::markSyncing(const std::string& id) { updateStatus(id, MutationStatus::Syncing, false); }
void MutationQueue::markFailed(const std::string& id) { updateStatus(id, MutationStatus::Failed, true); }
void MutationQueue::markRejected(const std::string& id) { updateStatus(id, MutationStatus::Rejected, false); }
void MutationQueue::markPending(const std::string& id) { updateStatus(id, MutationStatus::Pending, false); }

void MutationQueue::remove(const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement = prepare(database_, "DELETE FROM sync_queue WHERE id = ?", "Preparing removal");
  sqlite3_bind_text(statement.get(), 1, id.c_str(), -1, SQLITE_TRANSIENT);
  checkSqlite(sqlite3_step(statement.get()), database_, "Removing mutation");
}

void MutationQueue::upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, std::int64_t timestamp) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char* sql = "INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted) VALUES (?, ?, ?, ?, 0) "
                    "ON CONFLICT(table_name, record_id) DO UPDATE SET payload = excluded.payload, "
                    "updated_at = excluded.updated_at, deleted = 0 WHERE excluded.updated_at >= sync_records.updated_at";
  Statement statement = prepare(database_, sql, "Preparing record upsert");
  sqlite3_bind_text(statement.get(), 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 2, recordId.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 3, payload.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.get(), 4, timestamp);
  checkSqlite(sqlite3_step(statement.get()), database_, "Upserting record");
}

void MutationQueue::deleteRecord(const std::string& tableName, const std::string& recordId, std::int64_t timestamp) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char* sql = "INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted) VALUES (?, ?, ?, ?, 1) "
                    "ON CONFLICT(table_name, record_id) DO UPDATE SET "
                    "updated_at = excluded.updated_at, deleted = 1 WHERE excluded.updated_at >= sync_records.updated_at";
  Statement statement = prepare(database_, sql, "Preparing record delete");
  const std::string payload = "{\"id\":" + quoteJsonString(recordId) + "}";
  sqlite3_bind_text(statement.get(), 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 2, recordId.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 3, payload.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.get(), 4, timestamp);
  checkSqlite(sqlite3_step(statement.get()), database_, "Deleting record");
}

std::vector<std::string> MutationQueue::readRecords(const std::string& tableName) const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> records;
  Statement statement = prepare(database_, "SELECT payload FROM sync_records WHERE table_name = ? AND deleted = 0 ORDER BY updated_at ASC", "Preparing record read");
  sqlite3_bind_text(statement.get(), 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  while (true) {
    const int step = sqlite3_step(statement.get());
    if (step == SQLITE_DONE) {
      break;
    }
    if (step != SQLITE_ROW) {
      checkSqlite(step, database_, "Reading records");
      break;
    }
    records.emplace_back(columnText(statement.get(), 0));
  }
  return records;
}

std::vector<Tombstone> MutationQueue::readTombstones(const std::string& tableName) const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<Tombstone> tombstones;
  Statement statement = prepare(
      database_,
      "SELECT record_id, updated_at FROM sync_records WHERE table_name = ? AND deleted = 1 ORDER BY updated_at ASC",
      "Preparing tombstone read");
  sqlite3_bind_text(statement.get(), 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  while (true) {
    const int step = sqlite3_step(statement.get());
    if (step == SQLITE_DONE) {
      break;
    }
    if (step != SQLITE_ROW) {
      checkSqlite(step, database_, "Reading tombstones");
      break;
    }
    tombstones.push_back({
        columnText(statement.get(), 0),
        sqlite3_column_int64(statement.get(), 1),
    });
  }
  return tombstones;
}

void MutationQueue::clearTombstone(const std::string& tableName, const std::string& recordId, std::int64_t throughTimestamp) {
  std::lock_guard<std::mutex> lock(mutex_);
  Statement statement = prepare(
      database_,
      "DELETE FROM sync_records WHERE table_name = ? AND record_id = ? AND deleted = 1 AND updated_at <= ?",
      "Preparing tombstone clear");
  sqlite3_bind_text(statement.get(), 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement.get(), 2, recordId.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement.get(), 3, throughTimestamp);
  checkSqlite(sqlite3_step(statement.get()), database_, "Clearing tombstone");
}

const char* MutationQueue::operationToSql(MutationOperation operation) {
  switch (operation) {
    case MutationOperation::Create: return "CREATE";
    case MutationOperation::Update: return "UPDATE";
    case MutationOperation::Delete: return "DELETE";
  }
  throw std::invalid_argument("Unknown mutation operation");
}

MutationOperation MutationQueue::operationFromSql(const char* operation) {
  const std::string value = operation == nullptr ? std::string() : operation;
  if (value == "CREATE") return MutationOperation::Create;
  if (value == "UPDATE") return MutationOperation::Update;
  if (value == "DELETE") return MutationOperation::Delete;
  throw std::invalid_argument("Unknown mutation operation: " + value);
}

MutationStatus MutationQueue::statusFromSql(const char* status) {
  const std::string value = status == nullptr ? std::string() : status;
  if (value == "SYNCING") return MutationStatus::Syncing;
  if (value == "FAILED") return MutationStatus::Failed;
  if (value == "REJECTED") return MutationStatus::Rejected;
  if (value == "PENDING") return MutationStatus::Pending;
  throw std::invalid_argument("Unknown mutation status: " + value);
}

}  // namespace nitrosync
