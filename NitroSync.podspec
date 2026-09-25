require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name          = 'NitroSync'
  s.version       = package['version']
  s.summary       = package['description']
  s.homepage      = package['homepage']
  s.license       = package['license']
  s.author        = 'react-native-nitro-sync contributors'
  s.platforms     = { ios: '13.4' }
  s.source        = { git: package['repository']['url'], tag: "v#{s.version}" }
  s.swift_version = '5.9'

  s.source_files  = [
    'cpp/**/*.{h,cpp}',
    'ios/**/*.{h,m,mm,swift}'
  ]

  s.public_header_files = 'cpp/**/*.h'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'OTHER_CPLUSPLUSFLAGS' => '-DFMT_ENFORCE_COMPILE_STRING=0',
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_ROOT}/Headers/Public/NitroModules"'
  }

  s.dependency 'React-Core'
  s.dependency 'React-jsi'
  s.dependency 'NitroModules'
end