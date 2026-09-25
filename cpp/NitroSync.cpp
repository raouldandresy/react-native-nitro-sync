#include "NitroSync.h"

#include <HybridObjectRegistry.hpp>

#include <algorithm>
#include <cmath>
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

NitroSync::NitroSync() : HybridObject("NitroSync") {}

void NitroSync::loadHybridMethods() {
  HybridObject::loadHybridMethods();
  registerHybrids(this, [](margelo::nitro::Prototype& prototype) {
    prototype.registerHybridMethod("initialize", &NitroSync::initialize);
    prototype.registerHybridMethod("enqueueMutation", &NitroSync::enqueueMutation);
    prototype.registerHybridMethod("listPendingMutations", &NitroSync::listPendingMutations);
    prototype.registerHybridMethod("markMutationSyncing", &NitroSync::markMutationSyncing);
    prototype.registerHybridMethod("markMutationFailed", &NitroSync::markMutationFailed);
    prototype.registerHybridMethod("markMutationPending", &NitroSync::markMutationPending);
    prototype.registerHybridMethod("removeMutation", &NitroSync::removeMutation);
    prototype.registerHybridMethod("upsertRecord", &NitroSync::upsertRecord);
    prototype.registerHybridMethod("readRecords", &NitroSync::readRecords);
  });
}

void NitroSync::initialize(const std::string& databasePath) {
  queue_ = std::make_unique<MutationQueue>(databasePath);
  queue_->initialize();
}

MutationQueue& NitroSync::queue() {
  if (queue_ == nullptr) throw std::runtime_error("NitroSync.initialize() must be called first");
  return *queue_;
}

void NitroSync::enqueueMutation(const std::string& id, const std::string& tableName, const std::string& operation, const std::string& payload, double timestamp) {
  queue().enqueue({id, tableName, parseOperation(operation), payload, static_cast<std::int64_t>(timestamp), MutationStatus::Pending, 0});
}

std::vector<std::string> NitroSync::listPendingMutations(double limit) {
  const std::size_t safeLimit = static_cast<std::size_t>(std::max(0.0, std::floor(limit)));
  std::vector<std::string> serialized;
  for (const Mutation& mutation : queue().claimPending(safeLimit)) {
    serialized.push_back("{\"id\":" + quoteJson(mutation.id) +
                         ",\"tableName\":" + quoteJson(mutation.tableName) +
                         ",\"operation\":" + quoteJson(operationName(mutation.operation)) +
                         ",\"payload\":" + quoteJson(mutation.payload) +
                         ",\"timestamp\":" + std::to_string(mutation.timestamp) + "}");
  }
  return serialized;
}

void NitroSync::markMutationSyncing(const std::string& id) { queue().markSyncing(id); }
void NitroSync::markMutationFailed(const std::string& id) { queue().markFailed(id); }
void NitroSync::markMutationPending(const std::string& id) { queue().markPending(id); }
void NitroSync::removeMutation(const std::string& id) { queue().remove(id); }
void NitroSync::upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp) { queue().upsertRecord(tableName, recordId, payload, static_cast<std::int64_t>(timestamp)); }
std::vector<std::string> NitroSync::readRecords(const std::string& tableName) { return queue().readRecords(tableName); }

namespace {
const bool registered = [] {
  margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
      "NitroSync", [] { return std::make_shared<NitroSync>(); });
  return true;
}();
}  // namespace

}  // namespace nitrosync