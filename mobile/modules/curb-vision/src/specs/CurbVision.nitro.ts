import type { HybridObject } from 'react-native-nitro-modules';
import type { Frame } from 'react-native-vision-camera';

/**
 * Always four top-left-origin frame pixels: [x1, y1, x2, y2].
 * Nitrogen 0.37.1 rejects Swift tuples (swiftlang/swift#75865), so the
 * native ABI uses an array; index.ts refines the public type to a tuple.
 */
export type CurbBox = number[];

export type CurbVehicleDetection = {
  bbox: CurbBox;
  cls: string;
  confidence: number;
};

export type CurbSignDetection = {
  bbox: CurbBox;
  confidence: number;
  cropBase64: string;
};

export type CurbInferenceResult = {
  vehicles: CurbVehicleDetection[];
  signs: CurbSignDetection[];
  frameWidth: number;
  frameHeight: number;
};

export interface CurbVision extends HybridObject<{ ios: 'swift' }> {
  /**
   * Synchronous; caller must dispose the frame in finally after this returns.
   * Requires enablePhysicalBufferRotation: true (up, no pending mirroring).
   * Throws on model, frame, inference, output-shape, or crop errors.
   */
  detect(frame: Frame): CurbInferenceResult;
}
