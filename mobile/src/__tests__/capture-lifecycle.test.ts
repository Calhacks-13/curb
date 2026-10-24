import { CaptureController, DEFAULT_INTERVAL_MS as I } from "@/features/capture/CaptureController";

jest.useFakeTimers();

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe("CaptureController", () => {
  it("samples no faster than its interval", async () => {
    const capture = jest.fn(async () => "file://frame.jpg");
    const c = new CaptureController({ capture, upload: async () => {}, discard: () => {} });
    c.start();
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(I);
      await flush();
    }
    expect(capture).toHaveBeenCalledTimes(4); // four intervals, four frames
    c.stop();
  });

  it("keeps one upload in flight and drops samples instead of queueing", async () => {
    const pending = deferred<void>();
    const capture = jest.fn(async () => "file://frame.jpg");
    const upload = jest.fn(() => pending.promise);
    const c = new CaptureController({ capture, upload, discard: () => {} });
    c.start();
    jest.advanceTimersByTime(I);
    await flush();
    jest.advanceTimersByTime(3 * I); // three more ticks while the first upload hangs
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(c.stats.dropped).toBe(3);
    pending.resolve();
    await flush();
    c.stop();
  });

  it("drops a failed upload, keeps going, and always deletes the frame", async () => {
    const discard = jest.fn();
    const upload = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const c = new CaptureController({ capture: async () => "file://f.jpg", upload, discard });
    c.start();
    jest.advanceTimersByTime(I);
    await flush();
    jest.advanceTimersByTime(I);
    await flush();
    expect(c.stats).toMatchObject({ failed: 1, sent: 1 });
    expect(discard).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it("stops sampling and never uploads a frame captured after stop", async () => {
    const shot = deferred<string>();
    const upload = jest.fn(async () => {});
    const discard = jest.fn();
    const c = new CaptureController({ capture: () => shot.promise, upload, discard });
    c.start();
    jest.advanceTimersByTime(I);
    c.stop(); // e.g. app went to background mid-capture
    shot.resolve("file://late.jpg");
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledWith("file://late.jpg");
    jest.advanceTimersByTime(10 * I);
    expect(c.running).toBe(false);
  });
});
