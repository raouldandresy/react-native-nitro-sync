cmake_minimum_required(VERSION 3.22.1)
project(NitroSync)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_VERBOSE_MAKEFILE ON)

if(NOT DEFINED OP_SQLITE_DIR)
  message(FATAL_ERROR "OP_SQLITE_DIR must point to the Android project directory for @op-engineering/op-sqlite")
endif()

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_package(react-native-nitro-modules REQUIRED CONFIG)

add_library(NitroSync SHARED
  ../cpp/MutationQueue.cpp
  ../cpp/NitroSync.cpp
  ${OP_SQLITE_DIR}/../cpp/sqlite3.c
  src/main/cpp/NitroSyncOnLoad.cpp
)

target_include_directories(NitroSync PRIVATE
  ../cpp
  ${OP_SQLITE_DIR}/../cpp
)

target_compile_options(NitroSync PRIVATE
  -fexceptions
  -frtti
  -Wall
  -Wextra
  -fstack-protector-all
)

target_link_libraries(NitroSync
  react-native-nitro-modules::NitroModules
  log
  android
)

include(${CMAKE_CURRENT_SOURCE_DIR}/../nitrogen/generated/android/NitroSync+autolinking.cmake)
