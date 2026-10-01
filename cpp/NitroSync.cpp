#include "NitroSync.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <stdexcept>

namespace nitrosync {
namespace {

std::string databaseDirectory;

}  // namespace

std::string resolveDatabasePath(const std::string& name) {
  if (name.find('/') != std::string::npos) {
    // Caller supplied an explicit path; respect it as-is.
    return name;
  }
#if defined(__APPLE__)
  // iOS/tvOS sandboxes always set HOME to the app's container root, with a
  // "Documents" subdirectory guaranteed to exist and be writable. Resolving
  // through HOME avoids depending on Foundation/Objective-C from this
  // platform-agnostic translation unit.
  const char* home = std::getenv("HOME");
  const std::string base = home != nullptr ? std::string(home) + "/Documents" : ".";
  return base + "/" + name;
#else
  if (databaseDirectory.empty()) {
    throw std::runtime_error("Android database directory has not been initialized");
  }
  return databaseDirectory + "/" + name;
#endif
}

void setDatabaseDirectory(const std::string& directory) {
  databaseDirectory = directory;
}

}  // namespace nitrosync

namespace margelo::nitro::nitrosync {
namespace {

using QueueOperation = ::nitrosync::MutationOperation;

QueueOperation toQueueOperation(MutationOperation operation) {
  switch (operation) {
    case MutationOperation::CREATE: return QueueOperation::Create;
    case MutationOperation::UPDATE: return QueueOperation::Update;
    case MutationOperation::DELETE: return QueueOperation::Delete;
  }
  throw std::invalid_argument("Unknown mutation operation");
}

const char* operationName(QueueOperation operation) {
  switch (operation) {
    case QueueOperation::Create: return "CREATE";
    case QueueOperation::Update: return "UPDATE";
    case QueueOperation::Delete: return "DELETE";
  }
  throw std::invalid_argument("Unknown mutation operation");
}

std::string quoteJson(const std::string& value) {
  static constexpr char hex[] = "0123456789abcdef";
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
          escaped.push_back(hex[(character >> 4) & 0x0f]);
          escaped.push_back(hex[character & 0x0f]);
        } else {
          escaped.push_back(static_cast<char>(character));
        }
    }
  }
  escaped.push_back('"');
  return escaped;
}

}  // namespace

void NitroSync::initialize(const std::string& databasePath) {
  queue_ = std::make_unique<::nitrosync::MutationQueue>(
      ::nitrosync::resolveDatabasePath(databasePath));
  queue_->initialize();
}

void NitroSync::applyMutation(
    const std::string& id,
    const std::string& tableName,
    MutationOperation operation,
    const std::string& payload,
    double timestamp,
    double schemaVersion,
    const std::string& recordId,
    const std::string& recordPayload,
    bool deleted) {
  queue().applyMutation(
      {id,
       tableName,
       toQueueOperation(operation),
       payload,
       static_cast<std::int64_t>(timestamp),
       static_cast<std::int32_t>(schemaVersion),
       ::nitrosync::MutationStatus::Pending,
       0},
      recordId,
      recordPayload,
      deleted);
}

::nitrosync::MutationQueue& NitroSync::queue() {
  if (queue_ == nullptr) throw std::runtime_error("NitroSync.initialize() must be called first");
  return *queue_;
}

void NitroSync::enqueueMutation(
    const std::string& id,
    const std::string& tableName,
    MutationOperation operation,
    const std::string& payload,
    double timestamp,
    double schemaVersion) {
  queue().enqueue({
      id,
      tableName,
      toQueueOperation(operation),
      payload,
      static_cast<std::int64_t>(timestamp),
      static_cast<std::int32_t>(schemaVersion),
      ::nitrosync::MutationStatus::Pending,
      0,
  });
}

std::vector<std::string> NitroSync::listPendingMutations(double limit) {
  const std::size_t safeLimit = static_cast<std::size_t>(std::max(0.0, std::floor(limit)));
  std::vector<std::string> serialized;
  for (const ::nitrosync::Mutation& mutation : queue().claimPending(safeLimit)) {
    serialized.push_back("{\"id\":" + quoteJson(mutation.id) +
                         ",\"tableName\":" + quoteJson(mutation.tableName) +
                         ",\"operation\":" + quoteJson(operationName(mutation.operation)) +
                         ",\"payload\":" + quoteJson(mutation.payload) +
                         ",\"timestamp\":" + std::to_string(mutation.timestamp) +
                         ",\"schemaVersion\":" + std::to_string(mutation.schemaVersion) + "}");
  }
  return serialized;
}

std::vector<std::string> NitroSync::listPendingMutationsForTable(
    const std::string& tableName,
    double limit) {
  const std::size_t safeLimit = static_cast<std::size_t>(std::max(0.0, std::floor(limit)));
  std::vector<std::string> serialized;
  for (const ::nitrosync::Mutation& mutation : queue().claimPending(safeLimit, tableName)) {
    serialized.push_back("{\"id\":" + quoteJson(mutation.id) +
                         ",\"tableName\":" + quoteJson(mutation.tableName) +
                         ",\"operation\":" + quoteJson(operationName(mutation.operation)) +
                         ",\"payload\":" + quoteJson(mutation.payload) +
                         ",\"timestamp\":" + std::to_string(mutation.timestamp) +
                         ",\"schemaVersion\":" + std::to_string(mutation.schemaVersion) + "}");
  }
  return serialized;
}

std::vector<std::string> NitroSync::listRejectedMutations(const std::string& tableName) {
  return queue().listRejected(tableName);
}

void NitroSync::markMutationSyncing(const std::string& id) { queue().markSyncing(id); }
void NitroSync::markMutationFailed(const std::string& id) { queue().markFailed(id); }
void NitroSync::markMutationRejected(
    const std::string& id,
    const std::string& code,
    const std::string& message) {
  queue().markRejected(id, code, message);
}
void NitroSync::markMutationPending(const std::string& id) { queue().markPending(id); }
void NitroSync::retryRejectedMutation(const std::string& id) { queue().retryRejected(id); }
void NitroSync::discardRejectedMutation(const std::string& id) { queue().discardRejected(id); }
void NitroSync::removeMutation(const std::string& id) { queue().remove(id); }
void NitroSync::upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp) { queue().upsertRecord(tableName, recordId, payload, static_cast<std::int64_t>(timestamp)); }
void NitroSync::deleteRecord(const std::string& tableName, const std::string& recordId, double timestamp) { queue().deleteRecord(tableName, recordId, static_cast<std::int64_t>(timestamp)); }
std::vector<std::string> NitroSync::readRecords(const std::string& tableName) { return queue().readRecords(tableName); }
std::vector<std::string> NitroSync::readTombstones(const std::string& tableName) {
  std::vector<std::string> serialized;
  for (const ::nitrosync::Tombstone& tombstone : queue().readTombstones(tableName)) {
    serialized.push_back("{\"id\":" + quoteJson(tombstone.recordId) +
                         ",\"timestamp\":" + std::to_string(tombstone.timestamp) + "}");
  }
  return serialized;
}
void NitroSync::clearTombstone(const std::string& tableName, const std::string& recordId, double throughTimestamp) {
  queue().clearTombstone(tableName, recordId, static_cast<std::int64_t>(throughTimestamp));
}

}