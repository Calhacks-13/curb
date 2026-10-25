import type { DetectionSubmission, FrameAccepted, OnDeviceInference } from "@/api/types";
import { ApiError } from "@/api/errors";
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
    last_observed_at: "2026-10-24T21:00:00.000Z", base_confidence: 0.9, detection_confidence: 0.88, version: 1,
  },
};
beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-24T21:00:00.000Z") }));
afterEach(() => jest.useRealTimers());

describe("DetectionUploadController", () => {
  it("prevents delivery subscribers from mutating nested space, zone, and geometry confirmation data", async () => {
    const response: FrameAccepted = {
      ...accepted,
      space: {
        ...accepted.space!,
        location: { type: "Point", coordinates: [-122.4, 37.8] },
        stall_geometry: { type: "Polygon", coordinates: [[[-122.4, 37.8], [-122.3, 37.8], [-122.4, 37.8]]] },
      },
      zone: { id: "zone", geometry: { type: "LineString", coordinates: [[-122.4, 37.8], [-122.3, 37.8]] }, sign_rule_id: null, legal_status_now: "LEGAL", next_change_at: null, version: 1 },
    };
    const mutations: boolean[] = [];
    const onSpotConfirmed = jest.fn();
    const controller = new DetectionUploadController({
      context: () => context, upload: async () => response, onSpotConfirmed,
      onDelivery: (event) => {
        if (event.state !== "delivered") return;
        // Deliberately bypass static readonly checks to simulate a bad subscriber.
        const result = event.result as FrameAccepted;
        mutations.push(
          Reflect.set(result.space!, "internal_state", "OCCUPIED"),
          Reflect.set(result.space!.location.coordinates, 0, 0),
          Reflect.set(result.space!.stall_geometry.coordinates, 1, []),
          Reflect.set(result.space!.stall_geometry.coordinates[0], 1, [0, 0]),
          Reflect.set(result.space!.stall_geometry.coordinates[0][0], 0, 0),
          Reflect.set(result.zone!, "legal_status_now", "ILLEGAL"),
          Reflect.set(result.zone!.geometry.coordinates, 1, [0, 0]),
          Reflect.set(result.zone!.geometry.coordinates[0], 0, 0),
        );
      },
    });
    controller.start();
    controller.submit(inference);
    await flush();
    expect(mutations).toEqual([false, false, false, false, false, false, false, false]);
    expect(onSpotConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      space: expect.objectContaining({ internal_state: "OPEN", location: { type: "Point", coordinates: [-122.4, 37.8] }, stall_geometry: { type: "Polygon", coordinates: [[[-122.4, 37.8], [-122.3, 37.8], [-122.4, 37.8]]] } }),
      zone: expect.objectContaining({ legal_status_now: "LEGAL", geometry: { type: "LineString", coordinates: [[-122.4, 37.8], [-122.3, 37.8]] } }),
    }));
  });

  it("suppresses spot confirmation when a delivery subscriber stops the controller", async () => {
    const onSpotConfirmed = jest.fn();
    const controller = new DetectionUploadController({
      context: () => context, upload: async () => accepted, onSpotConfirmed,
      onDelivery: () => controller.stop(),
    });
    controller.start();
    controller.submit(inference);
    await flush();
    expect(controller.running).toBe(false);
    expect(onSpotConfirmed).not.toHaveBeenCalled();
    expect(controller.stats).toEqual({ sent: 1, dropped: 0, failed: 0 });
  });

  it("reports safe failures and later receipt with immutable stats snapshots", async () => {
    const onDelivery = jest.fn();
    const upload = jest.fn().mockRejectedValueOnce(new ApiError(502, "POST /v1/vision/detections failed (502)"))
      .mockResolvedValue({ ...accepted, vehicle_count: 0, gap_count: 0, scene_valid: false });
    const controller = new DetectionUploadController({ context: () => context, upload, onDelivery });
    controller.start();
    controller.submit(inference);
    await flush();
    const failure = onDelivery.mock.calls[0]?.[0];
    expect(failure).toEqual({ state: "failed", error: { status: 502, message: "Upload failed (HTTP 502). Retrying with the next frame." }, stats: { sent: 0, dropped: 0, failed: 1 } });
    controller.submit(inference);
    await flush();
    const receipt = onDelivery.mock.calls[1][0];
    expect(receipt).toEqual({ state: "delivered", result: expect.objectContaining({ vehicle_count: 0, gap_count: 0, scene_valid: false }), stats: { sent: 1, dropped: 0, failed: 1 } });
    expect(failure.stats).toEqual({ sent: 0, dropped: 0, failed: 1 });
    expect(Object.isFrozen(failure)).toBe(true);
    expect(Object.isFrozen(failure.stats)).toBe(true);
    expect(Object.isFrozen(failure.error)).toBe(true);
  });

  it.each([new Error("private payload/token"), new ApiError(0, "private payload/token", "request_timeout")])("releases failed requests and sanitizes errors (%s)", async (error) => {
    const onDelivery = jest.fn();
    const upload = jest.fn().mockRejectedValueOnce(error).mockResolvedValue(accepted);
    const controller = new DetectionUploadController({ context: () => context, upload, onDelivery });
    controller.start();
    controller.submit(inference);
    await flush();
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: "failed", error: expect.objectContaining({ message: expect.not.stringContaining("private") }) }));
    controller.submit(inference);
    await flush();
    expect(onDelivery).toHaveBeenLastCalledWith(expect.objectContaining({ state: "delivered" }));
  });

  it.each(["resolve", "reject"])("suppresses old-generation delivery events after stop/restart (%s)", async (settle) => {
    const pending = deferred<FrameAccepted>();
    const onDelivery = jest.fn();
    const upload = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(accepted);
    const controller = new DetectionUploadController({ context: () => context, upload, onDelivery });
    controller.start();
    controller.submit(inference);
    controller.stop();
    controller.start();
    if (settle === "resolve") pending.resolve(accepted);
    else pending.reject(new ApiError(502, "bad gateway"));
    await flush();
    expect(onDelivery).not.toHaveBeenCalled();
    controller.submit(inference);
    await flush();
    expect(onDelivery).toHaveBeenCalledTimes(1);
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ state: "delivered" }));
  });
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
