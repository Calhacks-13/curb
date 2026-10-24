import type { DetectionSubmission, FrameAccepted, OnDeviceInference } from "@/api/types";
import { DetectionUploadController } from "@/features/capture/DetectionUploadController";
import type { FrameContext } from "@/features/capture/detectionUpload";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const inference: OnDeviceInference = {
  vehicles: [{ bbox: [10, 20, 100, 200], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [200, 20, 230, 80], confidence: 0.8, cropBase64: "c2lnbg==" }],
  frameWidth: 1280, frameHeight: 720,
};
const context: FrameContext = {
  lat: 37.8, lng: -122.4, accuracy_m: null, heading: 180, device_id: "phone", session_id: "capture",
};
const accepted: FrameAccepted = {
  frame_id: "frame-1", accepted: true,
  space: {
    id: "spot", zone_id: "zone", location: { type: "Point", coordinates: [-122.4, 37.8] },
    stall_geometry: { type: "Polygon", coordinates: [] }, internal_state: "OPEN",
    last_observed_at: "2026-10-24T21:00:00.000Z", base_confidence: 0.9, version: 1,
  },
};
beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-24T21:00:00.000Z") }));
afterEach(() => jest.useRealTimers());

describe("DetectionUploadController", () => {
  it("returns immediately, permits one request, and drops arrivals without replay", async () => {
    const pending = deferred<FrameAccepted>();
    const upload = jest.fn(() => pending.promise);
    const controller = new DetectionUploadController({ context: () => context, upload });
    controller.start();
    controller.start();
    expect(controller.submit(inference)).toBeUndefined();
    controller.submit(inference);
    controller.submit(inference);
    controller.submit(inference);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(controller.stats).toEqual({ sent: 0, dropped: 3, failed: 0 });
    pending.resolve(accepted);
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(controller.stats).toEqual({ sent: 1, dropped: 3, failed: 0 });
    controller.submit(inference);
    expect(upload).toHaveBeenCalledTimes(2);
    await flush();
  });

  it("snapshots fresh context and capture time for each accepted result", async () => {
    const payloads: DetectionSubmission[] = [];
    let latest = { ...context };
    const controller = new DetectionUploadController({
      context: () => latest, upload: async (payload) => { payloads.push(payload); return accepted; },
    });
    controller.start();
    controller.submit(inference);
    latest.lat = 38;
    await flush();
    latest = { ...context, lat: 39, session_id: "next-session" };
    jest.setSystemTime(new Date("2026-10-24T21:00:01.000Z"));
    controller.submit(inference);
    await flush();
    expect(payloads).toEqual([
      expect.objectContaining({ lat: 37.8, session_id: "capture", captured_at: "2026-10-24T21:00:00.000Z" }),
      expect.objectContaining({ lat: 39, session_id: "next-session", captured_at: "2026-10-24T21:00:01.000Z" }),
    ]);
  });

  it("counts failures and accepts a fresh result after rejection", async () => {
    const pending = deferred<FrameAccepted>();
    const upload = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(accepted);
    const onSpotConfirmed = jest.fn();
    const controller = new DetectionUploadController({ context: () => context, upload, onSpotConfirmed });
    controller.start();
    controller.submit(inference);
    pending.reject(new Error("offline"));
    await flush();
    expect(controller.stats).toEqual({ sent: 0, dropped: 0, failed: 1 });
    expect(onSpotConfirmed).not.toHaveBeenCalled();
    controller.submit(inference);
    await flush();
    expect(controller.stats).toEqual({ sent: 1, dropped: 0, failed: 1 });
    expect(onSpotConfirmed).toHaveBeenCalledWith(accepted);
  });

  it("does not upload before start or after idempotent stop", () => {
    const upload = jest.fn(async () => accepted);
    const controller = new DetectionUploadController({ context: () => context, upload });
    controller.submit(inference);
    controller.start();
    controller.stop();
    controller.stop();
    controller.submit(inference);
    expect(upload).not.toHaveBeenCalled();
    expect(controller.running).toBe(false);
  });

  it("drops missing context without blocking the next valid result", async () => {
    let latest: FrameContext | null = null;
    const upload = jest.fn(async () => accepted);
    const controller = new DetectionUploadController({ context: () => latest, upload });
    controller.start();
    controller.submit(inference);
    expect(upload).not.toHaveBeenCalled();
    expect(controller.stats).toEqual({ sent: 0, dropped: 1, failed: 0 });
    latest = context;
    controller.submit(inference);
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("suppresses pending confirmation after stop (restart=%s)", async (restart) => {
    const pending = deferred<FrameAccepted>();
    const upload = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(accepted);
    const onSpotConfirmed = jest.fn();
    const controller = new DetectionUploadController({ context: () => context, upload, onSpotConfirmed });
    controller.start();
    controller.submit(inference);
    controller.stop();
    if (restart) {
      controller.start();
      controller.submit(inference);
      expect(upload).toHaveBeenCalledTimes(1);
    }
    pending.resolve(accepted);
    await flush();
    expect(onSpotConfirmed).not.toHaveBeenCalled();
    if (restart) {
      controller.submit(inference);
      await flush();
      expect(onSpotConfirmed).toHaveBeenCalledTimes(1);
    }
  });

  it("does not announce a response without a confirmed space", async () => {
    const onSpotConfirmed = jest.fn();
    const controller = new DetectionUploadController({
      context: () => context, upload: async () => ({ frame_id: "pending", accepted: true }), onSpotConfirmed,
    });
    controller.start();
    controller.submit(inference);
    await flush();
    expect(controller.stats.sent).toBe(1);
    expect(onSpotConfirmed).not.toHaveBeenCalled();
  });
});
