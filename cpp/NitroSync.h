#pragma once

#ifdef __cplusplus

#include <memory>
#include <string>
#include <vector>

#include "HybridNitroSyncSpec.hpp"
#include "MutationQueue.h"

namespace nitrosync {

// Resolves a bare database filename (e.g. "nitro-sync.db") into an absolute,
// writable path inside the app's sandbox. If `name` already contains a path
// separator, it is returned unchanged so callers can opt into an explicit
// location. See NitroSync.cpp for the platform-specific implementation.
std::string resolveDatabasePath(const std::string& name);
void setDatabaseDirectory(const std::string& directory);

}

namespace margelo::nitro::nitrosync {

class NitroSync final : public HybridNitroSyncSpec {
 public:
  NitroSync() : HybridObject(TAG) {}

  void initialize(const std::string& databasePath) override;
  void applyMutation(const std::string& id, const std::string& tableName, MutationOperation operation, const std::string& payload, double timestamp, double schemaVersion, const std::string& recordId, const std::string& recordPayload, bool deleted) override;
  void enqueueMutation(const std::string& id, const std::string& tableName, MutationOperation operation, const std::string& payload, double timestamp, double schemaVersion) override;
  std::vector<std::string> listPendingMutations(double limit) override;
  std::vector<std::string> listPendingMutationsForTable(const std::string& tableName, double limit) override;
  std::vector<std::string> listRejectedMutations(const std::string& tableName) override;
  void markMutationSyncing(const std::string& id) override;
  void markMutationFailed(const std::string& id) override;
  void markMutationRejected(const std::string& id, const std::string& code, const std::string& message) override;
  void markMutationPending(const std::string& id) override;
  void retryRejectedMutation(const std::string& id) override;
  void discardRejectedMutation(const std::string& id) override;
  void removeMutation(const std::string& id) override;
  void upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp) override;
  void deleteRecord(const std::string& tableName, const std::string& recordId, double timestamp) override;
  std::vector<std::string> readRecords(const std::string& tableName) override;
  std::vector<std::string> readTombstones(const std::string& tableName) override;
  void clearTombstone(const std::string& tableName, const std::string& recordId, double throughTimestamp) override;

 private:
  ::nitrosync::MutationQueue& queue();
  std::unique_ptr<::nitrosync::MutationQueue> queue_;
};

}

#endif // __cplusplus