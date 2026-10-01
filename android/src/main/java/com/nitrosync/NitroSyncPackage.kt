package com.nitrosync

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import com.margelo.nitro.nitrosync.NitroSyncOnLoad

class NitroSyncPackage : ReactPackage {
  init {
    NitroSyncOnLoad.initializeNative()
  }

  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    NitroSyncNative.setDatabaseDirectory(reactContext.filesDir.absolutePath)
    return emptyList()
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext
  ): List<ViewManager<*, *>> = emptyList()
}

private object NitroSyncNative {
  @JvmStatic
  external fun setDatabaseDirectory(directory: String)
}
