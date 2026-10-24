// Builds frame metadata and uploads one sampled JPEG (plan Task 7).

import { File } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

import { getApi } from "@/api/client";
import type { FrameAccepted, FrameMetadata } from "@/api/types";

const DEVICE_KEY = "curb.device-id";
let deviceId: string | null = null;

const randomId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Stable per-install device id (not tied to the person). */
export async function getDeviceId(): Promise<string> {
  if (deviceId) return deviceId;
  const saved = await SecureStore.getItemAsync(DEVICE_KEY).catch(() => null);
  deviceId = saved ?? randomId("dev");
  if (!saved) await SecureStore.setItemAsync(DEVICE_KEY, deviceId).catch(() => {});
  return deviceId;
}

export const newCaptureSessionId = () => randomId("cap");

export type FrameContext = Omit<FrameMetadata, "captured_at">;

export function uploadFrame(uri: string, ctx: FrameContext): Promise<FrameAccepted> {
  return getApi().uploadFrame(uri, { ...ctx, captured_at: new Date().toISOString() });
}

/** Frames are transient: delete the local JPEG as soon as we're done with it. */
export function discardFrame(uri: string) {
  try {
    new File(uri).delete();
  } catch {
    // Already gone.
  }
}
