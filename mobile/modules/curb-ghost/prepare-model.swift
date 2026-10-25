// macOS asset preparation only. swift prepare-model.swift meshes.json assets/parking-car.scn
import AppKit
import SceneKit
struct Mesh: Decodable { let name: String; let material: String; let vertices: [[Float]]; let normals: [[Float]]; let faces: [UInt32] }
let meshes = try JSONDecoder().decode([Mesh].self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
let scene = SCNScene()
for mesh in meshes {
  let vertices = mesh.vertices.map { SCNVector3($0[0], $0[1], $0[2]) }
  let normals = mesh.normals.map { SCNVector3($0[0], $0[1], $0[2]) }
  let data = mesh.faces.withUnsafeBytes { Data($0) }
  let element = SCNGeometryElement(data: data, primitiveType: .triangles, primitiveCount: mesh.faces.count / 3, bytesPerIndex: 4)
  let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices), SCNGeometrySource(normals: normals)], elements: [element])
  let name = mesh.name.lowercased()
  let glass = mesh.material == "glass" || name.contains("window") || name.contains("windshield")
  let tire = mesh.material.lowercased().contains("tire")
  let rim = mesh.material.lowercased().contains("rim")
  let hub = mesh.material == "hub"
  let trim = mesh.material == "trim"
  let light = mesh.material == "light"
  let lens = mesh.material == "lens"
  let material = SCNMaterial()
  material.lightingModel = .physicallyBased
  material.diffuse.contents = NSColor(white: glass ? 0.19 : tire ? 0.12 : hub ? 0.22 : trim ? 0.12 : rim ? 0.48 : lens ? 0.72 : 0.9, alpha: 1)
  material.metalness.contents = rim ? 0.35 : 0.08
  material.roughness.contents = tire ? 0.95 : glass ? 0.28 : 0.55
  material.emission.contents = light ? NSColor(white: 0.9, alpha: 1) : NSColor(white: 0.02, alpha: 1)
  // Transparency is applied once by the native renderer, not per surface.
  material.transparency = 1
  material.transparencyMode = .dualLayer
  material.writesToDepthBuffer = true
  geometry.materials = [material]
  let node = SCNNode(geometry: geometry);node.name = mesh.name
  scene.rootNode.addChildNode(node)
}
let shadowImage = NSImage(size: NSSize(width: 128, height: 128), flipped: false) { rect in
  NSGradient(starting: NSColor(white: 0, alpha: 0.14), ending: .clear)?.draw(in: NSBezierPath(ovalIn: rect), relativeCenterPosition: .zero)
  return true
}
let shadowMaterial = SCNMaterial()
shadowMaterial.lightingModel = .constant
shadowMaterial.diffuse.contents = shadowImage
shadowMaterial.writesToDepthBuffer = false
shadowMaterial.isDoubleSided = true
let plane = SCNPlane(width: 2.25, height: 4.55)
plane.materials = [shadowMaterial]
let shadow = SCNNode(geometry: plane)
shadow.name = "GroundShadow"
shadow.eulerAngles.x = -.pi / 2
shadow.position.y = 0.015
shadow.renderingOrder = -1
scene.rootNode.addChildNode(shadow)
print("Saved", scene.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: nil, delegate: nil, progressHandler: nil))
