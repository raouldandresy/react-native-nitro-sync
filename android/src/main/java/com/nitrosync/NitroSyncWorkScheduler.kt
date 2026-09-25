package com.nitrosync

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf

object NitroSyncWorkScheduler {
  private const val UNIQUE_WORK_NAME = "nitro-sync-background"

  fun enqueue(context: Context, databasePath: String) {
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()
    val request = OneTimeWorkRequestBuilder<NitroSyncWorker>()
      .setConstraints(constraints)
      .setInputData(workDataOf(NitroSyncWorker.KEY_DATABASE_PATH to databasePath))
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      UNIQUE_WORK_NAME,
      ExistingWorkPolicy.KEEP,
      request,
    )
  }
}
