import * as SecureStore from "expo-secure-store";

import type { DetectionSubmission, FrameMetadata, OnDeviceInference } from "@/api/types";

const DEVICE_KEY = "curb.device-id";
let deviceId: string | null = null;
const randomId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Stable device id, independent of the signed-in user. */
export async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const saved = await SecureStore.getItemAsync(DEVICE_KEY).catch(() => null);
  deviceId = saved ?? randomId("dev");
  if (!saved) await SecureStore.setItemAsync(DEVICE_KEY, deviceId).catch(() => {});
  return deviceId;
}

export const newCaptureSessionId = () => randomId("cap");
export type FrameContext = Omit<FrameMetadata, "captured_at">;

/** Whitelist the network contract: no native extras or full-frame data. */
export function buildDetectionSubmission(
  inference: OnDeviceInference,
  context: FrameContext,
  capturedAt: string,
): DetectionSubmission {
  return {
    captured_at: capturedAt,
    lat: context.lat,
    lng: context.lng,
    accuracy_m: context.accuracy_m,
    heading: context.heading !== null && Number.isFinite(context.heading) ? context.heading : 0,
    device_id: context.device_id,
    session_id: context.session_id,
    vehicles: inference.vehicles.map(({ bbox, cls, confidence }) => ({ bbox: [...bbox], cls, confidence })),
    signs: inference.signs.map(({ bbox, confidence, cropBase64 }) => ({ bbox: [...bbox], confidence, crop_b64: cropBase64 })),
    frame_width: inference.frameWidth,
    frame_height: inference.frameHeight,
  };
}
