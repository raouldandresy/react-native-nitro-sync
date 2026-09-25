#pragma once

#ifdef __cplusplus

#include <memory>
#include <string>
#include <vector>

#include <NitroModules/HybridObject.hpp>
#include "MutationQueue.h"

namespace nitrosync {

class NitroSync final : public margelo::nitro::HybridObject {
 public:
  NitroSync();

  void initialize(const std::string& databasePath);
  void enqueueMutation(const std::string& id, const std::string& tableName, const std::string& operation, const std::string& payload, double timestamp);
  std::vector<std::string> listPendingMutations(double limit);
  void markMutationSyncing(const std::string& id);
  void markMutationFailed(const std::string& id);
  void markMutationPending(const std::string& id);
  void removeMutation(const std::string& id);
  void upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, double timestamp);
  std::vector<std::string> readRecords(const std::string& tableName);

 protected:
  void loadHybridMethods() override;

 private:
  MutationQueue& queue();
  std::unique_ptr<MutationQueue> queue_;
};

}  // namespace nitrosync

#endif // __cplusplus