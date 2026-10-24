import type { DetectionSubmission, OnDeviceInference } from "@/api/types";
import { createDemoApi } from "@/demo/demoApi";
import { buildDetectionSubmission, getDeviceId, newCaptureSessionId } from "@/features/capture/detectionUpload";
import * as SecureStore from "expo-secure-store";

jest.mock("expo-file-system/legacy", () => { throw new Error("legacy FileSystem must not be loaded"); });
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn() }));
const context = { lat: 37.8, lng: -122.4, accuracy_m: null, heading: 180, device_id: "phone", session_id: "capture" };
const inference: OnDeviceInference = {
  vehicles: [{ bbox: [10, 20, 100, 200], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [200, 20, 230, 80], confidence: 0.8, cropBase64: "c2lnbg==" }],
  frameWidth: 1280, frameHeight: 720,
};
const payload: DetectionSubmission = {
  lat: 37.8, lng: -122.4, accuracy_m: null, heading: 180, device_id: "phone", session_id: "capture",
  captured_at: "2026-10-24T21:00:00.000Z",
  vehicles: [{ bbox: [10, 20, 100, 200], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [200, 20, 230, 80], confidence: 0.8, crop_b64: "c2lnbg==" }],
  frame_width: 1280, frame_height: 720,
};
const originalFetch = globalThis.fetch;
const originalUrl = process.env.EXPO_PUBLIC_API_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = originalUrl;
  jest.useRealTimers();
});
function liveApi(ok = true) {
  process.env.EXPO_PUBLIC_API_URL = "https://api.test";
  const fetchMock = jest.fn(async () => ({
    ok, status: ok ? 200 : 422,
    json: async () => ok ? { frame_id: "frame-1", accepted: true } : { code: "invalid_detection" },
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let api!: import("@/api/client").CurbApi;
  jest.isolateModules(() => { api = jest.requireActual<typeof import("@/api/client")>("@/api/client").getApi(); });
  return { api, fetchMock };
}
it("maps native inference to only snake-case fields without mutating it", () => {
  const native = { ...inference, frameUri: "file://frame.jpg", mask: [1, 2] };
  expect(buildDetectionSubmission(native, context, payload.captured_at)).toEqual(payload);
  expect(native.signs[0]).toEqual({ bbox: [200, 20, 230, 80], confidence: 0.8, cropBase64: "c2lnbg==" });
});
it.each([null, NaN, Infinity])("normalizes unavailable heading %s to a finite fallback", (heading) => {
  expect(buildDetectionSubmission(inference, { ...context, heading }, payload.captured_at).heading).toBe(0);
});
it("posts authenticated JSON with the exact body and no full-frame or multipart data", async () => {
  const { api, fetchMock } = liveApi();
  api.setToken("driver-token");
  await expect(api.uploadDetections(payload)).resolves.toEqual({ frame_id: "frame-1", accepted: true });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("https://api.test/v1/vision/detections", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer driver-token" },
    body: JSON.stringify(payload),
  });
});
it("uses the shared HTTP error contract for rejected detections", async () => {
  const { api } = liveApi(false);
  await expect(api.uploadDetections(payload)).rejects.toMatchObject({ status: 422, code: "invalid_detection" });
});
it("keeps demo detection submission non-confirming and deterministic without network I/O", async () => {
  jest.useFakeTimers({ now: new Date("2026-10-24T21:00:00.000Z") });
  const fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
  const api = createDemoApi();
  const expected = { frame_id: "frame_demo_1792875600000", accepted: false };
  await expect(api.uploadDetections(payload)).resolves.toEqual(expected);
  await expect(api.uploadDetections(payload)).resolves.toEqual(expected);
  expect(fetchMock).not.toHaveBeenCalled();
});
it("retains the persisted device id and creates separate capture sessions", async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue("saved-phone");
  expect(await getDeviceId()).toBe("saved-phone");
  expect(await getDeviceId()).toBe("saved-phone");
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  expect(newCaptureSessionId()).not.toBe(newCaptureSessionId());
});
