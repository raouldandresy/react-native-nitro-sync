#import <Foundation/Foundation.h>

#include <memory>

#include "NitroSync.h"

// NitroSync (cpp/NitroSync.cpp) self-registers with the Nitro
// HybridObjectRegistry via a C++ global constructor in an anonymous
// namespace. That works fine on Android, where the module is built into a
// shared library that is loaded in full via System.loadLibrary(). On iOS,
// however, this pod is linked as a static library: the linker only pulls
// object files out of a static archive when something references a symbol
// they define. Nothing in the app statically references NitroSync.cpp's
// symbols (JS reaches it dynamically through the string-keyed
// HybridObjectRegistry), so the whole translation unit — including its
// registration side effect — was being dead-stripped from the final binary,
// leaving "NitroSync" unregistered at runtime.
//
// Objective-C +load methods are always linked in (CocoaPods enables -ObjC
// for exactly this reason), so instantiating NitroSync here forces the
// linker to keep NitroSync.o, and with it the registration constructor, in
// the final app binary.
@interface NitroSyncLinkerWorkaround : NSObject
@end

@implementation NitroSyncLinkerWorkaround
+ (void)load {
  static const std::shared_ptr<nitrosync::NitroSync> keepAlive =
      std::make_shared<nitrosync::NitroSync>();
  (void)keepAlive;
}
@end
