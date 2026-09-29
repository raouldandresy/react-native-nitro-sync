#include "NitroSync.h"

#include <HybridObjectRegistry.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <stdexcept>

namespace nitrosync {
namespace {

MutationOperation parseOperation(const std::string& operation) {
  if (operation == "CREATE") return MutationOperation::Create;
  if (operation == "UPDATE") return MutationOperation::Update;
  if (operation == "DELETE") return MutationOperation::Delete;
  throw std::invalid_argument("Unknown mutation operation: " + operation);
}

std::string quoteJson(const std::string& value) {
  std::string escaped;
  escaped.reserve(value.size() + 2);
  escaped.push_back('"');
  for (const char character : value) {
    if (character == '"' || character == '\\') escaped.push_back('\\');
    escaped.push_back(character);
  }
  escaped.push_back('"');
  return escaped;
}

const char* operationName(MutationOperation operation) {
  switch (operation) {
    case MutationOperation::Create: return "CREATE";
    case MutationOperation::Update: return "UPDATE";
    case MutationOperation::Delete: return "DELETE";
  }
  throw std::invalid_argument("Unknown mutation operation");
}

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
  // Android has no writable-directory environment variable equivalent to
  // iOS's HOME; the app-private files directory must come from the Java
  // Context (see Context#getFilesDir()). Until that plumbing exists, fall
  // back to the given relative name, matching the previous behavior.
  return name;
#endif
}

NitroSync::NitroSync() : HybridObject("NitroSync") {}

void NitroSync::loadHybridMethods() {
  HybridObject::loadHybridMethods();
  registerHybrids(this, [](margelo::nitro::Prototype& prototype) {
    prototype.registerHybridMethod("initialize", &NitroSync::initialize);
    prototype.registerHybridMethod("enqueueMutation", &NitroSync::enqueueMutation);
    prototype.registerHybridMethod("listPendingMutations", &NitroSync::listPendingMutations);
    prototype.registerHybridMethod("markMutationSyncing", &NitroSync::markMutationSyncing);
    prototype.registerHybridMethod("markMutationFailed", &NitroSync::markMutationFailed);
    prototype.registerHybridMethod("markMutationRejected", &NitroSync::markMutationRejected);
    prototype.registerHybridMethod("markMutationPending", &NitroSync::markMutationPending);
    prototype.registerHybridMethod("removeMutation", &NitroSync::removeMutation);
    prototype.registerHybridMethod("upsertRecord", &NitroSync::upsertRecord);
    prototype.registerHybridMethod("deleteRecord", &NitroSync::deleteRecord);
    prototype.registerHybridMethod("readRecords", &NitroSync::readRecords);
    prototype.registerHybridMethod("readTombstones", &NitroSync::readTombstones);
    prototype.registerHybridMethod("clearTombstone", &NitroSync::clearTombstone);
  });
}

void NitroSync::initialize(const std::string& databasePath) {
  queue_ = std::make_unique<MutationQueue>(resolveDatabasePath(databasePath));
  queue_->initialize();
}

MutationQueue& NitroSync::queue() {
  if (queue_ == nullptr) throw std::runtime_error("NitroSync.initialize() must be called first");
  return *queue_;
}

void NitroSync::enqueueMutation(const std::string& id, const std::string& tableName, const std::string& operation, const std::string& payload, double timestamp, double schemaVersion) {
  queue().enqueue({
      id,
      tableName,
      parseOperation(operation),
      payload,
      static_cast<std::int64_t>(timestamp),
      static_cast<std::int32_t>(schemaVersion),
      MutationStatus::Pending,
      0,
  });
}

std::vector<std::string> NitroSync::listPendingMutations(double limit) {
  const std::size_t safeLimit = static_cast<std::size_t>(std::max(0.0, std::floor(limit)));
  std::vector<std::string> serialized;
  for (const Mutation& mutation : queue().claimPending(safeLimit)) {
    serialized.push_back("{\"id\":" + quoteJson(mutation.id) +
                         ",\"tableName\":" + quoteJson(mutation.tableName) +
                         ",\"operation\":" + quoteJson(operationName(mutation.operation)) +
                         ",\"payload\":" + quoteJson(mutation.payload) +
                         ",\"timestamp\":" + std::to_string(mutation.timestamp) +
                         ",\"schemaVersion\":" + std::to_string(mutation.schemaVersion) + "}");
  }
  return serialized;
}

void NitroSync::markMutationSyncing(const std::string& id) { queue().markSyncing(id); }
void NitroSync::markMutationFailed(const std::string& id) { queue().markFailed(id); }
void NitroSync::markMutationRejected(const std::string& id) { queue().markRejected(id); }
void NitroSync::markMutationPending(const std::string& id) { queue().markPending(id); }
void NitroSync::removeMutation(const std::string& id) { queue().remove(id); }
void NitroSync::upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp) { queue().upsertRecord(tableName, recordId, payload, static_cast<std::int64_t>(timestamp)); }
void NitroSync::deleteRecord(const std::string& tableName, const std::string& recordId, double timestamp) { queue().deleteRecord(tableName, recordId, static_cast<std::int64_t>(timestamp)); }
std::vector<std::string> NitroSync::readRecords(const std::string& tableName) { return queue().readRecords(tableName); }
std::vector<std::string> NitroSync::readTombstones(const std::string& tableName) {
  std::vector<std::string> serialized;
  for (const Tombstone& tombstone : queue().readTombstones(tableName)) {
    serialized.push_back("{\"id\":" + quoteJson(tombstone.recordId) +
                         ",\"timestamp\":" + std::to_string(tombstone.timestamp) + "}");
  }
  return serialized;
}
void NitroSync::clearTombstone(const std::string& tableName, const std::string& recordId, double throughTimestamp) {
  queue().clearTombstone(tableName, recordId, static_cast<std::int64_t>(throughTimestamp));
}

namespace {
const bool registered = [] {
  margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "NitroSync", [] { return std::make_shared<NitroSync>(); });
  return true;
}();
}  // namespace

}  // namespace nitrosync