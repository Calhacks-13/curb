import ExpoModulesCore
import SceneKit
import UIKit

public class CurbGhostModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CurbGhost")
    View(CurbGhostView.self) {
      Prop("yaw") { (view: CurbGhostView, yaw: Double) in view.setYaw(yaw) }
    }
  }
}

/// An image-anchored illustration, not an ARSession or metric fit measurement.
final class CurbGhostView: ExpoView {
  private let renderer = SCNView()
  private let vehicle = SCNNode()
  private let camera = SCNNode()
  private var yaw: Float = 0.35
  private var framingBounds: (minX: Float, maxX: Float, minY: Float)?
  private static let template: SCNScene? = {
    let host = Bundle(for: CurbGhostView.self)
    guard let bundleURL = host.url(forResource: "CurbGhostAssets", withExtension: "bundle"),
          let bundle = Bundle(url: bundleURL),
          let url = bundle.url(forResource: "parking-car", withExtension: "scn") else { return nil }
    return try? SCNScene(url: url)
  }()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    renderer.backgroundColor = .clear
    renderer.isOpaque = false
    // Composite the finished render once so overlapping surfaces do not turn
    // an otherwise translucent car opaque. Camera pixels remain visible.
    renderer.alpha = 0.42
    renderer.antialiasingMode = .multisampling4X
    renderer.preferredFramesPerSecond = 30
    renderer.rendersContinuously = false
    renderer.isPlaying = false
    renderer.autoenablesDefaultLighting = false
    addSubview(renderer)
    let scene = SCNScene()
    if let template = Self.template {
      let model = template.rootNode.clone()
      let (low, high) = model.boundingBox
      let length = max(high.z - low.z, high.x - low.x)
      if length > 0 {
        let scale: Float = 4.4 / length
        model.scale = SCNVector3(scale, scale, scale)
        model.position = SCNVector3(-(high.x + low.x) / 2 * scale, -low.y * scale, -(high.z + low.z) / 2 * scale)
      }
      vehicle.addChildNode(model)
    }
    scene.rootNode.addChildNode(vehicle)
    camera.camera = SCNCamera()
    camera.camera?.usesOrthographicProjection = true
    camera.camera?.zNear = 0.1
    camera.camera?.zFar = 50
    camera.position = SCNVector3(0, 2.2, 8)
    camera.look(at: SCNVector3(0, 0.55, 0))
    scene.rootNode.addChildNode(camera)
    renderer.pointOfView = camera
    let key = SCNNode()
    key.light = SCNLight()
    key.light?.type = .directional
    key.light?.intensity = 900
    key.eulerAngles = SCNVector3(-0.7, -0.5, 0)
    scene.rootNode.addChildNode(key)
    let fill = SCNNode()
    fill.light = SCNLight()
    fill.light?.type = .ambient
    fill.light?.intensity = 180
    fill.light?.color = UIColor.white
    scene.rootNode.addChildNode(fill)
    renderer.scene = scene
    setYaw(Double(yaw))
  }

  func setYaw(_ value: Double) {
    guard value.isFinite else { return }
    if yaw != Float(value) { framingBounds = nil }
    yaw = Float(value)
    vehicle.eulerAngles.y = yaw
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    renderer.frame = bounds
    guard bounds.width > 0, bounds.height > 0 else { return }
    camera.position = SCNVector3(0, 2.2, 8)
    camera.look(at: SCNVector3(0, 0.55, 0))
    var minX = Float.infinity, maxX = -Float.infinity
    var minY = Float.infinity
    // Frame actual geometry in camera space; avoid the old fixed camera padding.
    // The shadow must not shrink the car or change its road contact point.
    if let cached = framingBounds {
      minX = cached.minX; maxX = cached.maxX; minY = cached.minY
    } else {
      vehicle.enumerateChildNodes { node, _ in
        guard node.name != "GroundShadow", let geometry = node.geometry else { return }
        func measure(_ local: SCNVector3) {
          let point = node.convertPosition(local, to: self.camera)
          minX = min(minX, point.x); maxX = max(maxX, point.x)
          minY = min(minY, point.y)
        }
        if let source = geometry.sources(for: .vertex).first,
           source.usesFloatComponents, source.bytesPerComponent == 4, source.componentsPerVector >= 3 {
          source.data.withUnsafeBytes { (data: UnsafeRawBufferPointer) in
            for index in stride(from: 0, to: source.vectorCount, by: max(1, source.vectorCount / 160)) {
              let offset = source.dataOffset + index * source.dataStride
              guard offset + 12 <= data.count else { continue }
              measure(SCNVector3(
                data.loadUnaligned(fromByteOffset: offset, as: Float.self),
                data.loadUnaligned(fromByteOffset: offset + 4, as: Float.self),
                data.loadUnaligned(fromByteOffset: offset + 8, as: Float.self)))
            }
          }
        } else {
          let (low, high) = geometry.boundingBox
          for x in [low.x, high.x] {
            for y in [low.y, high.y] {
              for z in [low.z, high.z] { measure(SCNVector3(x, y, z)) }
            }
          }
        }
      }
      if minX.isFinite && maxX.isFinite && minY.isFinite {
        framingBounds = (minX, maxX, minY)
      }
    }
    guard minX.isFinite, maxX.isFinite, minY.isFinite, maxX > minX else { return }
    let aspect = bounds.width / bounds.height
    let scale = CGFloat(maxX - minX) / aspect / 2 / 0.99
    camera.camera?.orthographicScale = scale
    // A small bottom inset keeps the wheels on the neighboring cars' ground line.
    let center = SCNVector3((minX + maxX) / 2, minY + Float(scale * 0.94), 0)
    camera.position = camera.convertPosition(center, to: nil)
    renderer.setNeedsDisplay()
  }
}
