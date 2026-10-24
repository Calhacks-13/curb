// Frame sampling with backpressure (plan Task 7): at most one sample every
// `intervalMs` (default ~2 fps), at most one upload in flight, and a sample is
// dropped rather than queued when the previous one hasn't returned. Every frame
// is discarded after its upload attempt; nothing is kept on the device.

export type CaptureDeps = {
  /** Takes a photo, resolving to a local file URI. */
  capture: () => Promise<string>;
  upload: (uri: string) => Promise<void>;
  /** Deletes the local file. Must not throw. */
  discard: (uri: string) => void;
};

export type CaptureStats = { sent: number; dropped: number; failed: number };

export const DEFAULT_INTERVAL_MS = 500;

export class CaptureController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  readonly stats: CaptureStats = { sent: 0, dropped: 0, failed: 0 };

  constructor(
    private readonly deps: CaptureDeps,
    private readonly intervalMs = DEFAULT_INTERVAL_MS,
  ) {}

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.inFlight) {
      this.stats.dropped++;
      return;
    }
    this.inFlight = true;
    let uri: string | null = null;
    try {
      uri = await this.deps.capture();
      if (!this.running) return; // stopped while capturing: don't upload
      await this.deps.upload(uri);
      this.stats.sent++;
    } catch (err) {
      console.warn("[CaptureController] frame failed:", err);
      this.stats.failed++;
    } finally {
      if (uri) this.deps.discard(uri);
      this.inFlight = false;
    }
  }
}
