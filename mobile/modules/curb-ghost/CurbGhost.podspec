Pod::Spec.new do |s|
  s.name = 'CurbGhost'
  s.version = '1.0.0'
  s.summary = 'Native 3D parking visualization'
  s.description = 'Image-anchored ghost vehicle rendered over the live camera.'
  s.license = { :type => 'MIT' }
  s.author = 'Curb'
  s.homepage = 'https://github.com/Calhacks-13/curb'
  s.source = { :git => 'https://github.com/Calhacks-13/curb.git' }
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = ['SceneKit', 'UIKit']
  s.source_files = 'ios/**/*.swift'
  s.resource_bundles = { 'CurbGhostAssets' => ['assets/*.scn', 'assets/CREDITS.txt'] }
end
