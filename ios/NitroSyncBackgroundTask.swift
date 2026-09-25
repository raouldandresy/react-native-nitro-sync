import BackgroundTasks
import Foundation

@objc public final class NitroSyncBackgroundTask: NSObject {
  private static var handler: (() -> Bool)?

  @objc public static func register(identifier: String, handler: @escaping () -> Bool) {
    self.handler = handler
    BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
      guard let processingTask = task as? BGProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      processingTask.expirationHandler = {
        processingTask.setTaskCompleted(success: false)
      }
      let success = self.handler?() ?? false
      processingTask.setTaskCompleted(success: success)
    }
  }

  @objc public static func schedule(identifier: String, earliestBeginDate: Date? = nil) {
    let request = BGProcessingTaskRequest(identifier: identifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = earliestBeginDate
    try? BGTaskScheduler.shared.submit(request)
  }
}
