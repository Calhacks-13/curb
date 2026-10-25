import AVFoundation
import CoreImage
import CoreML
import Foundation
import ImageIO
import NitroModules
import Vision
import VisionCamera

/// Synchronous inference: the caller owns/disposes the Frame after detect returns.
/// No Frame, CMSampleBuffer, CVPixelBuffer, CIImage, or request handler is cached.
final class HybridCurbVision: HybridCurbVisionSpec {
  private static let confidenceThreshold = 0.25
  private static let vehicleClasses = [2: "car", 3: "motorcycle", 5: "bus", 7: "truck"]
  // VNCoreMLRequest is stateful. Serialize access, including first model loading.
  private let inferenceLock = NSLock()
  private let imageContext = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpaceCreateDeviceRGB()
  private lazy var models: Result<ModelState, Error> = Result { try ModelState() }

  func detect(frame: any HybridFrameSpec) throws -> CurbInferenceResult {
    inferenceLock.lock()
    defer { inferenceLock.unlock() }
    return try autoreleasepool {
      guard frame.isValid else {
        throw failure("Invalid or disposed camera Frame")
      }
      guard let nativeFrame = frame as? any NativeFrame else {
        throw failure("Frame is not a VisionCamera NativeFrame")
      }
      guard let sampleBuffer = nativeFrame.sampleBuffer, sampleBuffer.isValid,
            let pixelBuffer = sampleBuffer.imageBuffer else {
        throw failure("Frame has no valid CMSampleBuffer/CVPixelBuffer (it may be disposed)")
      }
      // Task 5 must enablePhysicalBufferRotation. Reject metadata transforms,
      // rather than returning boxes/crops in a different coordinate system.
      guard frame.orientation == .up, !frame.isMirrored else {
        throw failure("CurbVision requires enablePhysicalBufferRotation: true; expected orientation up and isMirrored false")
      }
      let width = CVPixelBufferGetWidth(pixelBuffer)
      let height = CVPixelBufferGetHeight(pixelBuffer)
      guard width > 0, height > 0, frame.width == Double(width), frame.height == Double(height) else {
        throw failure("Frame dimensions do not match its nonempty pixel buffer")
      }

      let state = try models.get()
      let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
      do {
        try handler.perform([state.vehicles.request, state.signs.request])
      } catch {
        throw failure("CoreML/Vision inference failed: \(error.localizedDescription)")
      }
      let vehicleCandidates = try candidates(from: state.vehicles, width: width, height: height)
      let signCandidates = try candidates(from: state.signs, width: width, height: height)
      let vehicles = vehicleCandidates.compactMap { candidate -> CurbVehicleDetection? in
        guard let cls = Self.vehicleClasses[candidate.classIndex] else { return nil }
        return CurbVehicleDetection(bbox: candidate.box, cls: cls, confidence: candidate.confidence)
      }
      let source = CIImage(cvPixelBuffer: pixelBuffer)
      let signs = try signCandidates.map { candidate in
        CurbSignDetection(
          bbox: candidate.box,
          confidence: candidate.confidence,
          cropBase64: try cropJPEG(source: source, box: candidate.box, frameHeight: height)
        )
      }
      return CurbInferenceResult(
        vehicles: vehicles, signs: signs, frameWidth: Double(width), frameHeight: Double(height)
      )
    }
  }

  private func candidates(from detector: Detector, width: Int, height: Int) throws -> [Candidate] {
    guard let results = detector.request.results else {
      throw failure("\(detector.stem): Vision returned no results")
    }
    // Vision promotes Apple NMS pipelines to recognized-object observations on
    // supported OS versions. These boxes already include Vision's scale mapping
    // and have a bottom-left origin; raw CoreML coordinates below are top-left.
    if let objects = results as? [VNRecognizedObjectObservation] {
      return try objects.compactMap { object in
        guard let label = object.labels.max(by: { $0.confidence < $1.confidence }) else {
          throw failure("\(detector.stem): object observation has no class confidence")
        }
        // Vision normalizes class labels to sum to one and puts their original
        // total in object.confidence. Reconstruct the model's class score.
        let labelConfidence = Double(label.confidence)
        let objectConfidence = Double(object.confidence)
        guard labelConfidence.isFinite, (0...1).contains(labelConfidence),
              objectConfidence.isFinite, objectConfidence >= 0 else {
          throw failure("\(detector.stem): invalid label/object confidence")
        }
        let confidence = labelConfidence * objectConfidence
        guard confidence.isFinite, (0...1).contains(confidence) else {
          throw failure("\(detector.stem): invalid reconstructed class confidence \(confidence)")
        }
        guard confidence >= Self.confidenceThreshold else { return nil }
        guard let classIndex = detector.classNames.firstIndex(of: label.identifier) else {
          throw failure("\(detector.stem): unexpected NMS class label '\(label.identifier)'")
        }
        let rect = object.boundingBox
        let box = try clampedBox(
          x1: rect.minX * Double(width), y1: (1 - rect.maxY) * Double(height),
          x2: rect.maxX * Double(width), y2: (1 - rect.minY) * Double(height),
          width: width, height: height
        )
        return box.map { Candidate(box: $0, classIndex: classIndex, confidence: confidence) }
      }
    }
    guard let features = results as? [VNCoreMLFeatureValueObservation], !features.isEmpty else {
      throw failure("\(detector.stem): unsupported Vision result type; expected NMS objects or feature arrays")
    }
    guard let confidence = features.first(where: { $0.featureName == "confidence" })?.featureValue.multiArrayValue,
          let coordinates = features.first(where: { $0.featureName == "coordinates" })?.featureValue.multiArrayValue else {
      throw failure("\(detector.stem): missing confidence/coordinates MLMultiArray outputs")
    }
    let scores = try Matrix(confidence, name: "\(detector.stem).confidence")
    let boxes = try Matrix(coordinates, name: "\(detector.stem).coordinates")
    // The pinned exporter pads YOLO-World's 7 classes to 80 zero-filled channels
    // to work around Apple's MLProgram NMS bug. Accept only these known layouts.
    let supportedClasses = detector.classNames.count == 7 ? [7, 80] : [80]
    guard supportedClasses.contains(scores.columns), boxes.columns == 4, scores.rows == boxes.rows else {
      throw failure("\(detector.stem): unsupported confidence \(confidence.shape) / coordinates \(coordinates.shape) shapes")
    }
    var candidates: [Candidate] = []
    for row in 0..<scores.rows {
      var bestClass = 0
      var bestScore = -Double.infinity
      for column in 0..<scores.columns {
        let value = scores.value(row, column)
        guard value.isFinite, (0...1).contains(value) else {
          throw failure("\(detector.stem): invalid class confidence at [\(row),\(column)]")
        }
        if value > bestScore { bestScore = value; bestClass = column }
      }
      guard bestScore >= Self.confidenceThreshold else { continue }
      guard bestClass < detector.classNames.count else {
        throw failure("\(detector.stem): padded sign class has nonzero confidence")
      }
      // Ultralytics' CoreML NMS uses normalized center-x/center-y/width/height,
      // in the input image's top-left coordinate system. scaleFill maps this
      // directly back to the source buffer's full width/height (no letterbox).
      let cx = boxes.value(row, 0), cy = boxes.value(row, 1)
      let w = boxes.value(row, 2), h = boxes.value(row, 3)
      guard w.isFinite, h.isFinite, w > 0, h > 0 else {
        throw failure("\(detector.stem): invalid NMS box dimensions at row \(row)")
      }
      if let box = try clampedBox(
        x1: (cx - w / 2) * Double(width), y1: (cy - h / 2) * Double(height),
        x2: (cx + w / 2) * Double(width), y2: (cy + h / 2) * Double(height),
        width: width, height: height
      ) {
        candidates.append(Candidate(box: box, classIndex: bestClass, confidence: bestScore))
      }
    }
    return candidates
  }

  private func clampedBox(x1: Double, y1: Double, x2: Double, y2: Double, width: Int, height: Int) throws -> CurbBox? {
    guard [x1, y1, x2, y2].allSatisfy(\.isFinite), x2 > x1, y2 > y1 else {
      throw failure("Model returned a non-finite or non-positive-area bounding box")
    }
    let left = min(max(x1, 0), Double(width)), top = min(max(y1, 0), Double(height))
    let right = min(max(x2, 0), Double(width)), bottom = min(max(y2, 0), Double(height))
    guard right > left, bottom > top else { return nil } // Entirely outside the frame.
    return [left, top, right, bottom]
  }

  private func cropJPEG(source: CIImage, box: CurbBox, frameHeight: Int) throws -> String {
    // CIImage is bottom-left origin. Outward pixel rounding preserves tiny signs.
    let left = floor(box[0]), top = floor(box[1]), right = ceil(box[2]), bottom = ceil(box[3])
    let rect = CGRect(x: left, y: Double(frameHeight) - bottom, width: right - left, height: bottom - top)
    let crop = source.cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
    guard !crop.extent.isEmpty,
          let jpeg = imageContext.jpegRepresentation(
            of: crop, colorSpace: colorSpace,
            options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.85]
          ), !jpeg.isEmpty else {
      throw failure("Failed to crop/encode parking-sign JPEG at \(rect)")
    }
    return jpeg.base64EncodedString()
  }
}

private typealias CurbBox = [Double]

private struct Candidate {
  let box: CurbBox
  let classIndex: Int
  let confidence: Double
}

/// An explicitly stride-aware view: [N,C] or [1,N,C], never a flattened copy.
private struct Matrix {
  let array: MLMultiArray
  let rows: Int
  let columns: Int
  let rowStride: Int
  let columnStride: Int

  init(_ array: MLMultiArray, name: String) throws {
    let shape = array.shape.map(\.intValue)
    let strides = array.strides.map(\.intValue)
    guard (shape.count == 2 || (shape.count == 3 && shape[0] == 1)),
          shape.count == strides.count, shape.allSatisfy({ $0 >= 0 }),
          strides.allSatisfy({ $0 > 0 }), let columns = shape.last, columns > 0 else {
      throw failure("\(name): unsupported rank/shape/strides \(shape)/\(strides); expected [N,C] or [1,N,C]")
    }
    let rows = shape[shape.count - 2]
    let (count, overflow) = rows.multipliedReportingOverflow(by: columns)
    guard !overflow, count == array.count else {
      throw failure("\(name): inconsistent shape/count \(shape)/\(array.count)")
    }
    guard [.float16, .float32, .double].contains(array.dataType) else {
      throw failure("\(name): unsupported MLMultiArray data type \(array.dataType)")
    }
    self.array = array
    self.rows = rows
    self.columns = columns
    self.rowStride = strides[strides.count - 2]
    self.columnStride = strides[strides.count - 1]
  }

  func value(_ row: Int, _ column: Int) -> Double {
    let offset = row * rowStride + column * columnStride
    switch array.dataType {
    case .float16: return Double(array.dataPointer.assumingMemoryBound(to: Float16.self)[offset])
    case .float32: return Double(array.dataPointer.assumingMemoryBound(to: Float.self)[offset])
    case .double: return array.dataPointer.assumingMemoryBound(to: Double.self)[offset]
    default: preconditionFailure("Matrix.init rejects unsupported data types")
    }
  }
}

private struct ModelState {
  let vehicles: Detector
  let signs: Detector

  init() throws {
    vehicles = try Detector(stem: "yolov8s-seg", classCount: 80)
    signs = try Detector(stem: "yolov8m-worldv2", classCount: 7)
  }
}

private struct Detector {
  let stem: String
  let classNames: [String]
  let model: MLModel
  let visionModel: VNCoreMLModel
  let request: VNCoreMLRequest

  init(stem: String, classCount: Int) throws {
    self.stem = stem
    let owner = Bundle(for: HybridCurbVision.self)
    let bundles = [owner, Bundle.main].compactMap { bundle -> Bundle? in
      guard let url = bundle.url(forResource: "CurbVisionModels", withExtension: "bundle") else { return nil }
      return Bundle(url: url)
    }
    guard let url = (bundles + [owner, Bundle.main]).compactMap({
      $0.url(forResource: stem, withExtension: "mlmodelc")
    }).first else {
      throw failure("Missing bundled \(stem).mlmodelc; run mobile/scripts/export-coreml-models.py, then rebuild the iOS app")
    }
    do {
      let config = MLModelConfiguration()
      config.computeUnits = .cpuAndNeuralEngine
      model = try MLModel(contentsOf: url, configuration: config)
      let outputs = model.modelDescription.outputDescriptionsByName
      guard outputs["confidence"]?.type == .multiArray, outputs["coordinates"]?.type == .multiArray else {
        throw failure("\(stem): model is missing confidence/coordinates multi-array outputs; export with embedded NMS")
      }
      let metadata = model.modelDescription.metadata[.creatorDefinedKey] as? [String: String]
      guard let json = metadata?["curb.class_names"], let data = json.data(using: .utf8),
            let names = try JSONSerialization.jsonObject(with: data) as? [String], names.count == classCount else {
        throw failure("\(stem): missing/invalid curb.class_names export metadata")
      }
      if classCount == 7 {
        // Must match SIGN_PROMPTS in scripts/export-coreml-models.py exactly.
        guard names == ["parking sign", "no parking sign", "traffic sign", "parking meter", "parking garage sign", "parking lot sign", "parking arrow sign"] else {
          throw failure("\(stem): sign prompt order differs from the Curb export contract")
        }
      } else {
        guard names[2] == "car", names[3] == "motorcycle", names[5] == "bus", names[7] == "truck" else {
          throw failure("\(stem): vehicle class order differs from COCO")
        }
      }
      classNames = names
      visionModel = try VNCoreMLModel(for: model)
      request = VNCoreMLRequest(model: visionModel)
      request.imageCropAndScaleOption = .scaleFill
    } catch {
      throw failure("Unable to load \(stem).mlmodelc: \(error.localizedDescription)")
    }
  }
}

private func failure(_ message: String) -> NSError {
  NSError(domain: "CurbVision", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
