#include <jni.h>

#include <fbjni/fbjni.h>

#include "NitroSyncOnLoad.hpp"
#include "NitroSync.h"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::nitrosync::initialize(vm);
}

extern "C" JNIEXPORT void JNICALL
Java_com_nitrosync_NitroSyncNative_setDatabaseDirectory(
    JNIEnv* env, jclass, jstring directory) {
  const char* path = env->GetStringUTFChars(directory, nullptr);
  if (path == nullptr) {
    return;
  }
  nitrosync::setDatabaseDirectory(path);
  env->ReleaseStringUTFChars(directory, path);
}
