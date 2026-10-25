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
  let glass = name.contains("window") || name.contains("windshield")
  let tire = mesh.material.lowercased().contains("tire")
  let rim = mesh.material.lowercased().contains("rim")
  let light = name.contains("headlight") || name.contains("taillight")
  let material = SCNMaterial()
  material.lightingModel = .physicallyBased
  material.diffuse.contents = glass ? NSColor(red: 0.08, green: 0.20, blue: 0.18, alpha: 1) : tire ? NSColor(red: 0.10, green: 0.17, blue: 0.15, alpha: 1) : NSColor(red: 0.72, green: 0.92, blue: 0.83, alpha: 1)
  material.metalness.contents = rim ? 0.75 : glass ? 0.5 : 0.2
  material.roughness.contents = tire ? 0.7 : glass ? 0.12 : 0.3
  material.emission.contents = light ? NSColor(red: 0.6, green: 0.9, blue: 0.8, alpha: 1) : NSColor(red: 0.015, green: 0.035, blue: 0.025, alpha: 1)
  material.transparency = glass ? 0.55 : tire || rim ? 0.7 : 0.53
  material.transparencyMode = .dualLayer
  material.writesToDepthBuffer = true
  geometry.materials = [material]
  let node = SCNNode(geometry: geometry);node.name = mesh.name
  scene.rootNode.addChildNode(node)
}
print("Saved", scene.write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: nil, delegate: nil, progressHandler: nil))
