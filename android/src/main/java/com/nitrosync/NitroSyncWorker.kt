package com.nitrosync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Host apps provide the actual transport delegate before enqueueing this worker.
 * The worker owns scheduling and retry semantics; credentials and network policy remain in the host.
 */
class NitroSyncWorker(
  appContext: Context,
  workerParams: WorkerParameters,
) : CoroutineWorker(appContext, workerParams) {
  override suspend fun doWork(): Result {
    return try {
      val databasePath = inputData.getString(KEY_DATABASE_PATH)
        ?: return Result.failure()
      val completed = NitroSyncBackgroundDelegate.run(applicationContext, databasePath)
      if (completed) Result.success() else Result.retry()
    } catch (_: Exception) {
      Result.retry()
    }
  }

  companion object {
    const val KEY_DATABASE_PATH = "nitro_sync_database_path"
  }
}

object NitroSyncBackgroundDelegate {
  @Volatile
  var runner: (suspend (Context, String) -> Boolean)? = null

  suspend fun run(context: Context, databasePath: String): Boolean {
    return runner?.invoke(context, databasePath) ?: false
  }
}
