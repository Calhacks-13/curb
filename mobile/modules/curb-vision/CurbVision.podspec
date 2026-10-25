require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CurbVision'
  s.version = package['version']
  s.summary = package['description']
  s.homepage = package['homepage']
  s.license = package['license']
  s.authors = package['author']
  s.source = { :git => 'https://github.com/Calhacks-13/curb.git', :tag => s.version.to_s }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source_files = ['ios/**/*.swift']
  s.frameworks = ['AVFoundation', 'CoreML', 'Vision', 'CoreImage', 'ImageIO']
  # Xcode compiles these packages into .mlmodelc inside this resource bundle.
  s.resource_bundles = { 'CurbVisionModels' => ['models/*.mlpackage'] }

  load File.join(__dir__, 'nitrogen/generated/ios/CurbVision+autolinking.rb')
  add_nitrogen_files(s)
  s.dependency 'NitroModules', '0.37.1'
  s.dependency 'VisionCamera', '5.2.3'
  install_modules_dependencies(s)
end
