#pragma once

#ifdef __cplusplus

#include <cstdint>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

struct sqlite3;

namespace nitrosync {

enum class MutationOperation { Create, Update, Delete };
enum class MutationStatus { Pending, Syncing, Failed, Rejected };

struct Mutation {
  std::string id;
  std::string tableName;
  MutationOperation operation;
  std::string payload;
  std::int64_t timestamp;
  std::int32_t schemaVersion;
  MutationStatus status;
  std::int32_t retryCount;
};

struct Tombstone {
  std::string recordId;
  std::int64_t timestamp;
};

class MutationQueue {
 public:
  explicit MutationQueue(std::string databasePath);
  ~MutationQueue();

  MutationQueue(const MutationQueue&) = delete;
  MutationQueue& operator=(const MutationQueue&) = delete;

  void initialize();
  void applyMutation(
      const Mutation& mutation,
      const std::string& recordId,
      const std::string& recordPayload,
      bool deleted);
  void enqueue(const Mutation& mutation);
  std::vector<Mutation> claimPending(std::size_t limit, const std::optional<std::string>& tableName = std::nullopt);
  std::vector<std::string> listRejected(const std::string& tableName) const;
  void markSyncing(const std::string& id);
  void markFailed(const std::string& id);
  void markRejected(const std::string& id, const std::string& code, const std::string& message);
  void markPending(const std::string& id);
  void retryRejected(const std::string& id);
  void discardRejected(const std::string& id);
  void remove(const std::string& id);
  void upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, std::int64_t timestamp);
  void deleteRecord(const std::string& tableName, const std::string& recordId, std::int64_t timestamp);
  std::vector<std::string> readRecords(const std::string& tableName) const;
  std::vector<Tombstone> readTombstones(const std::string& tableName) const;
  void clearTombstone(const std::string& tableName, const std::string& recordId, std::int64_t throughTimestamp);

 private:
  void execute(const char* sql) const;
  void recoverSyncing();
  void updateStatus(const std::string& id, MutationStatus status, bool incrementRetry);
  static const char* operationToSql(MutationOperation operation);
  static MutationOperation operationFromSql(const char* operation);
  static MutationStatus statusFromSql(const char* status);

  sqlite3* database_ = nullptr;
  std::string databasePath_;
  mutable std::mutex mutex_;
};

}  // namespace nitrosync

#endif // __cplusplus
