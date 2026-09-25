cmake_minimum_required(VERSION 3.22.1)
project(NitroSync)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_VERBOSE_MAKEFILE ON)

if(NOT DEFINED NITRO_MODULES_DIR)
  message(FATAL_ERROR "NITRO_MODULES_DIR must point to react-native-nitro-modules")
endif()

find_package(ReactAndroid REQUIRED CONFIG)
find_package(fbjni REQUIRED CONFIG)
find_package(NitroModules REQUIRED CONFIG)

add_library(NitroSync SHARED
  ../cpp/MutationQueue.cpp
  ../cpp/NitroSync.cpp
)

target_include_directories(NitroSync PRIVATE
  ../cpp
  ${NITRO_MODULES_DIR}/cpp/core
  ${NITRO_MODULES_DIR}/cpp/entrypoint
  ${NITRO_MODULES_DIR}/cpp/jsi
  ${NITRO_MODULES_DIR}/cpp/platform
  ${NITRO_MODULES_DIR}/cpp/prototype
  ${NITRO_MODULES_DIR}/cpp/registry
  ${NITRO_MODULES_DIR}/cpp/templates
  ${NITRO_MODULES_DIR}/cpp/threading
  ${NITRO_MODULES_DIR}/cpp/utils
)

target_compile_options(NitroSync PRIVATE -fexceptions -frtti -Wall -Wextra -fstack-protector-all)
target_link_libraries(NitroSync
  NitroModules::NitroModules
  ReactAndroid::jsi
  fbjni::fbjni
  log
  android
)
