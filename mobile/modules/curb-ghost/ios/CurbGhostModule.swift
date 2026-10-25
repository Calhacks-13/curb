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
    fill.light?.color = UIColor(red: 0.7, green: 0.9, blue: 0.83, alpha: 1)
    scene.rootNode.addChildNode(fill)
    renderer.scene = scene
    setYaw(Double(yaw))
  }

  func setYaw(_ value: Double) {
    guard value.isFinite else { return }
    yaw = Float(value)
    vehicle.eulerAngles.y = yaw
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    renderer.frame = bounds
    let aspect = max(bounds.width / max(bounds.height, 1), 0.3)
    let horizontal = abs(sin(CGFloat(yaw))) * 4.4 + abs(cos(CGFloat(yaw))) * 2.4
    let scale = max(1.2, horizontal / aspect / 2) * 1.05
    camera.camera?.orthographicScale = scale
    let target = Float(scale * 0.72)
    camera.position = SCNVector3(0, target + 1.65, 8)
    camera.look(at: SCNVector3(0, target, 0))
    renderer.setNeedsDisplay()
  }
}
