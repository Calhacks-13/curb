import { Platform } from 'react-native';
import type { Frame } from 'react-native-vision-camera';
import type {
  CurbInferenceResult as NativeInferenceResult,
  CurbSignDetection as NativeSignDetection,
  CurbVehicleDetection as NativeVehicleDetection,
  CurbVision as NativeCurbVision,
} from './specs/CurbVision.nitro';

// The native implementation constructs exactly four coordinates. Preserve the
// network contract's tuple type without unsupported Swift std::tuple bindings.
export type CurbBox = [number, number, number, number];
export type CurbVehicleDetection = Omit<NativeVehicleDetection, 'bbox'> & { bbox: CurbBox };
export type CurbSignDetection = Omit<NativeSignDetection, 'bbox'> & { bbox: CurbBox };
export type CurbInferenceResult = Omit<NativeInferenceResult, 'vehicles' | 'signs'> & {
  vehicles: CurbVehicleDetection[];
  signs: CurbSignDetection[];
};
export interface CurbVision extends Omit<NativeCurbVision, 'detect'> {
  detect(frame: Frame): CurbInferenceResult;
}

let instance: CurbVision | undefined;

/** Call on the RN runtime, then capture the HybridObject in the frame worklet. */
export function getCurbVision(): CurbVision {
  if (Platform.OS !== 'ios') {
    throw new Error('CurbVision CoreML inference is only available on iOS.');
  }
  if (!instance) {
    // Defer even loading the native Nitro runtime on Android/web imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NitroModules } = require('react-native-nitro-modules') as typeof import('react-native-nitro-modules');
    instance = NitroModules.createHybridObject<CurbVision>('CurbVision');
  }
  return instance;
}
