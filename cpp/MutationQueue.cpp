#include "MutationQueue.h"

#include <sqlite3.h>

#include <stdexcept>
#include <utility>

namespace nitrosync {
namespace {

constexpr const char* kSchema = R"SQL(
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS sync_queue (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  timestamp INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCING', 'FAILED')),
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

void checkSqlite(int result, sqlite3* database, const char* context) {
  if (result != SQLITE_OK && result != SQLITE_DONE && result != SQLITE_ROW) {
    const char* message = database == nullptr ? "SQLite error" : sqlite3_errmsg(database);
    throw std::runtime_error(std::string(context) + ": " + message);
  }
}

}  // namespace

MutationQueue::MutationQueue(std::string databasePath) : databasePath_(std::move(databasePath)) {}

MutationQueue::~MutationQueue() {
  if (database_ != nullptr) {
    sqlite3_close(database_);
  }
}

void MutationQueue::initialize() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (database_ != nullptr) {
    return;
  }
  checkSqlite(sqlite3_open(databasePath_.c_str(), &database_), database_, "Opening database");
  try {
    execute(kSchema);
  } catch (...) {
    sqlite3_close(database_);
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

void MutationQueue::enqueue(const Mutation& mutation) {
  std::lock_guard<std::mutex> lock(mutex_);
  const char* sql = "INSERT OR REPLACE INTO sync_queue "
                    "(id, table_name, operation, payload, timestamp, status, retry_count) "
                    "VALUES (?, ?, ?, ?, ?, 'PENDING', 0)";
  sqlite3_stmt* statement = nullptr;
  checkSqlite(sqlite3_prepare_v2(database_, sql, -1, &statement, nullptr), database_, "Preparing enqueue");
  sqlite3_bind_text(statement, 1, mutation.id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement, 2, mutation.tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement, 3, operationToSql(mutation.operation), -1, SQLITE_STATIC);
  sqlite3_bind_text(statement, 4, mutation.payload.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement, 5, mutation.timestamp);
  const int result = sqlite3_step(statement);
  sqlite3_finalize(statement);
  checkSqlite(result, database_, "Enqueue mutation");
}

std::vector<Mutation> MutationQueue::claimPending(std::size_t limit) {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<Mutation> mutations;
  execute("BEGIN IMMEDIATE TRANSACTION;");
  try {
    const char* selectSql = "SELECT id, table_name, operation, payload, timestamp, status, retry_count "
                            "FROM sync_queue WHERE status IN ('PENDING', 'FAILED') "
                            "ORDER BY timestamp ASC LIMIT ?";
    sqlite3_stmt* statement = nullptr;
    checkSqlite(sqlite3_prepare_v2(database_, selectSql, -1, &statement, nullptr), database_, "Preparing claim");
    sqlite3_bind_int64(statement, 1, static_cast<sqlite3_int64>(limit));
    while (sqlite3_step(statement) == SQLITE_ROW) {
      mutations.push_back({
          reinterpret_cast<const char*>(sqlite3_column_text(statement, 0)),
          reinterpret_cast<const char*>(sqlite3_column_text(statement, 1)),
          operationFromSql(reinterpret_cast<const char*>(sqlite3_column_text(statement, 2))),
          reinterpret_cast<const char*>(sqlite3_column_text(statement, 3)),
          sqlite3_column_int64(statement, 4),
          statusFromSql(reinterpret_cast<const char*>(sqlite3_column_text(statement, 5))),
          sqlite3_column_int(statement, 6)});
    }
    sqlite3_finalize(statement);
    for (const Mutation& mutation : mutations) {
      sqlite3_stmt* update = nullptr;
      checkSqlite(sqlite3_prepare_v2(database_, "UPDATE sync_queue SET status = 'SYNCING' WHERE id = ?", -1, &update, nullptr), database_, "Preparing claim update");
      sqlite3_bind_text(update, 1, mutation.id.c_str(), -1, SQLITE_TRANSIENT);
      checkSqlite(sqlite3_step(update), database_, "Claiming mutation");
      sqlite3_finalize(update);
    }
    execute("COMMIT;");
  } catch (...) {
    execute("ROLLBACK;");
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
  sqlite3_stmt* statement = nullptr;
  checkSqlite(sqlite3_prepare_v2(database_, sql, -1, &statement, nullptr), database_, "Preparing status update");
  const char* statusText = status == MutationStatus::Pending ? "PENDING" : status == MutationStatus::Syncing ? "SYNCING" : "FAILED";
  sqlite3_bind_text(statement, 1, statusText, -1, SQLITE_STATIC);
  sqlite3_bind_text(statement, 2, id.c_str(), -1, SQLITE_TRANSIENT);
  checkSqlite(sqlite3_step(statement), database_, "Updating mutation status");
  sqlite3_finalize(statement);
}

void MutationQueue::markSyncing(const std::string& id) { updateStatus(id, MutationStatus::Syncing, false); }
void MutationQueue::markFailed(const std::string& id) { updateStatus(id, MutationStatus::Failed, true); }
void MutationQueue::markPending(const std::string& id) { updateStatus(id, MutationStatus::Pending, false); }

void MutationQueue::remove(const std::string& id) {
  std::lock_guard<std::mutex> lock(mutex_);
  sqlite3_stmt* statement = nullptr;
  checkSqlite(sqlite3_prepare_v2(database_, "DELETE FROM sync_queue WHERE id = ?", -1, &statement, nullptr), database_, "Preparing removal");
  sqlite3_bind_text(statement, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  checkSqlite(sqlite3_step(statement), database_, "Removing mutation");
  sqlite3_finalize(statement);
}

void MutationQueue::upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, std::int64_t timestamp) {
  std::lock_guard<std::mutex> lock(mutex_);
  sqlite3_stmt* statement = nullptr;
  const char* sql = "INSERT INTO sync_records(table_name, record_id, payload, updated_at, deleted) VALUES (?, ?, ?, ?, 0) "
                    "ON CONFLICT(table_name, record_id) DO UPDATE SET payload = excluded.payload, "
                    "updated_at = excluded.updated_at, deleted = 0 WHERE excluded.updated_at >= sync_records.updated_at";
  checkSqlite(sqlite3_prepare_v2(database_, sql, -1, &statement, nullptr), database_, "Preparing record upsert");
  sqlite3_bind_text(statement, 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement, 2, recordId.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(statement, 3, payload.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(statement, 4, timestamp);
  checkSqlite(sqlite3_step(statement), database_, "Upserting record");
  sqlite3_finalize(statement);
}

std::vector<std::string> MutationQueue::readRecords(const std::string& tableName) const {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> records;
  sqlite3_stmt* statement = nullptr;
  checkSqlite(sqlite3_prepare_v2(database_, "SELECT payload FROM sync_records WHERE table_name = ? AND deleted = 0 ORDER BY updated_at ASC", -1, &statement, nullptr), database_, "Preparing record read");
  sqlite3_bind_text(statement, 1, tableName.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(statement) == SQLITE_ROW) {
    records.emplace_back(reinterpret_cast<const char*>(sqlite3_column_text(statement, 0)));
  }
  sqlite3_finalize(statement);
  return records;
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
  if (std::string(operation) == "CREATE") return MutationOperation::Create;
  if (std::string(operation) == "UPDATE") return MutationOperation::Update;
  return MutationOperation::Delete;
}

MutationStatus MutationQueue::statusFromSql(const char* status) {
  if (std::string(status) == "SYNCING") return MutationStatus::Syncing;
  if (std::string(status) == "FAILED") return MutationStatus::Failed;
  return MutationStatus::Pending;
}

}  // namespace nitrosync
