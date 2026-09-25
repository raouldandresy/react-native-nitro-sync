#pragma once

#ifdef __cplusplus

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

struct sqlite3;

namespace nitrosync {

enum class MutationOperation { Create, Update, Delete };
enum class MutationStatus { Pending, Syncing, Failed };

struct Mutation {
  std::string id;
  std::string tableName;
  MutationOperation operation;
  std::string payload;
  std::int64_t timestamp;
  MutationStatus status;
  std::int32_t retryCount;
};

class MutationQueue {
 public:
  explicit MutationQueue(std::string databasePath);
  ~MutationQueue();

  MutationQueue(const MutationQueue&) = delete;
  MutationQueue& operator=(const MutationQueue&) = delete;

  void initialize();
  void enqueue(const Mutation& mutation);
  std::vector<Mutation> claimPending(std::size_t limit);
  void markSyncing(const std::string& id);
  void markFailed(const std::string& id);
  void markPending(const std::string& id);
  void remove(const std::string& id);
  void upsertRecord(const std::string& tableName, const std::string& recordId, const std::string& payload, std::int64_t timestamp);
  std::vector<std::string> readRecords(const std::string& tableName) const;

 private:
  void execute(const char* sql) const;
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