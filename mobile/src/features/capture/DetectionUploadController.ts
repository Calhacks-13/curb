import type { DetectionSubmission, FrameAccepted, OnDeviceInference } from "@/api/types";
import { ApiError } from "@/api/errors";
import { buildDetectionSubmission, type FrameContext } from "./detectionUpload";

export type DetectionUploadDeps = {
  context: () => FrameContext | null;
  upload: (payload: DetectionSubmission) => Promise<FrameAccepted>;
  onSpotConfirmed?: (result: FrameAccepted) => void;
  onDelivery?: (event: DetectionDeliveryEvent) => void;
};
export type DetectionUploadStats = { sent: number; dropped: number; failed: number };
export type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
export type DetectionDeliveryEvent =
  | Readonly<{ state: "delivered"; source: DeepReadonly<OnDeviceInference>; result: DeepReadonly<FrameAccepted>; stats: Readonly<DetectionUploadStats> }>
  | Readonly<{ state: "failed"; error: Readonly<{ status: number | null; message: string }>; stats: Readonly<DetectionUploadStats> }>;

/** The JSON response snapshot owns every nested object and geometry array. */
function immutableSnapshot<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) return Object.freeze(value.map((child) => immutableSnapshot(child))) as DeepReadonly<T>;
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, immutableSnapshot(child)]),
    )) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

/** One request at a time; busy results are discarded and never replayed. */
export class DetectionUploadController {
  private active = false;
  private generation = 0;
  private inFlight = false;
  readonly stats: DetectionUploadStats = { sent: 0, dropped: 0, failed: 0 };

  constructor(private readonly deps: DetectionUploadDeps) {}

  get running() { return this.active; }

  start(): void { this.active = true; }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.generation++;
  }

  submit(inference: OnDeviceInference): void {
    if (!this.active) return;
    if (this.inFlight) {
      this.stats.dropped++;
      return;
    }
    const context = this.deps.context();
    if (!context) {
      this.stats.dropped++;
      return;
    }
    const payload = buildDetectionSubmission(inference, context, new Date().toISOString());
    this.inFlight = true;
    const source = immutableSnapshot({ ...inference, signs: inference.signs.map((sign) => ({ ...sign, cropBase64: "" })) });
    void this.send(payload, this.generation, source);
  }

  private async send(payload: DetectionSubmission, generation: number, source: DeepReadonly<OnDeviceInference>): Promise<void> {
    try {
      const result = await this.deps.upload(payload);
      this.stats.sent++;
      if (this.active && generation === this.generation) {
        this.deps.onDelivery?.(Object.freeze({ state: "delivered", source, result: immutableSnapshot(result), stats: Object.freeze({ ...this.stats }) }));
        // A subscriber may stop or restart scanning synchronously.
        if (this.active && generation === this.generation && result.space) this.deps.onSpotConfirmed?.(result);
      }
    } catch (error: unknown) {
      this.stats.failed++;
      if (this.active && generation === this.generation) {
        const status = error instanceof ApiError ? error.status : null;
        const message = status != null && status > 0
          ? `Upload failed (HTTP ${status}). Retrying with the next frame.`
          : error instanceof ApiError && error.code === "request_timeout"
            ? "Upload timed out. Retrying with the next frame."
            : "Could not upload detections. Retrying with the next frame.";
        this.deps.onDelivery?.(Object.freeze({ state: "failed", error: Object.freeze({ status, message }), stats: Object.freeze({ ...this.stats }) }));
      }
    } finally {
      this.inFlight = false;
    }
  }
}
