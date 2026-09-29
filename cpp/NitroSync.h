#pragma once

#ifdef __cplusplus

#include <memory>
#include <string>
#include <vector>

#include <NitroModules/HybridObject.hpp>
#include "MutationQueue.h"

namespace nitrosync {

// Resolves a bare database filename (e.g. "nitro-sync.db") into an absolute,
// writable path inside the app's sandbox. If `name` already contains a path
// separator, it is returned unchanged so callers can opt into an explicit
// location. See NitroSync.cpp for the platform-specific implementation.
std::string resolveDatabasePath(const std::string& name);

class NitroSync final : public margelo::nitro::HybridObject {
 public:
  NitroSync();

  void initialize(const std::string& databasePath);
  void enqueueMutation(const std::string& id, const std::string& tableName, const std::string& operation, const std::string& payload, double timestamp, double schemaVersion);
  std::vector<std::string> listPendingMutations(double limit);
  void markMutationSyncing(const std::string& id);
  void markMutationFailed(const std::string& id);
  void markMutationRejected(const std::string& id);
  void markMutationPending(const std::string& id);
  void removeMutation(const std::string& id);
  void upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp);
  void deleteRecord(const std::string& tableName, const std::string& recordId, double timestamp);
  std::vector<std::string> readRecords(const std::string& tableName);
  std::vector<std::string> readTombstones(const std::string& tableName);
  void clearTombstone(const std::string& tableName, const std::string& recordId, double throughTimestamp);

 protected:
  void loadHybridMethods() override;

 private:
  MutationQueue& queue();
  std::unique_ptr<MutationQueue> queue_;
};

}  // namespace nitrosync

#endif // __cplusplus