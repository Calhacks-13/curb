import type { DetectionSubmission, FrameAccepted, OnDeviceInference } from "@/api/types";
import { buildDetectionSubmission, type FrameContext } from "./detectionUpload";

export type DetectionUploadDeps = {
  context: () => FrameContext | null;
  upload: (payload: DetectionSubmission) => Promise<FrameAccepted>;
  onSpotConfirmed?: (result: FrameAccepted) => void;
};
export type DetectionUploadStats = { sent: number; dropped: number; failed: number };

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
    void this.send(payload, this.generation);
  }

  private async send(payload: DetectionSubmission, generation: number): Promise<void> {
    try {
      const result = await this.deps.upload(payload);
      this.stats.sent++;
      if (this.active && generation === this.generation && result.space) this.deps.onSpotConfirmed?.(result);
    } catch {
      this.stats.failed++;
    } finally {
      this.inFlight = false;
    }
  }
}
