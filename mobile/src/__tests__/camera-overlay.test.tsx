import { act, fireEvent, render, screen, within } from "@testing-library/react-native";
import { useState } from "react";
import { Linking, Platform } from "react-native";
import type { Frame, UseFrameOutputProps } from "react-native-vision-camera";

import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { CameraOverlay } from "@/components/CameraOverlay";
import type { FrameContext } from "@/features/capture/detectionUpload";

// Keep the component, controller, payload builder, and HTTP client real.
const mockRequestPermission = jest.fn(async () => true);
const mockCameraMount = jest.fn();
const mockCameraUnmount = jest.fn();
let mockPermission = { hasPermission: true, canRequestPermission: false, status: "authorized", requestPermission: mockRequestPermission };
let mockDevice: object | undefined = { id: "back-camera" };
let mockFrameOptions: UseFrameOutputProps;
const mockFrameOutput = { kind: "frame-output" };
jest.mock("react-native-vision-camera", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    Camera: (props: object) => {
      React.useEffect(() => {
        mockCameraMount();
        return () => mockCameraUnmount();
      }, []);
      return <View {...props} testID="native-camera" />;
    },
    useCameraPermission: () => mockPermission,
    useCameraDevice: () => mockDevice,
    useFrameOutput: (options: UseFrameOutputProps) => { mockFrameOptions = options; return mockFrameOutput; },
  };
}, { virtual: true });
type Scheduled = { fn: (...args: never[]) => unknown; args: never[] };
const mockScheduled: Scheduled[] = [];
const mockScheduleOnRN = jest.fn((fn: Scheduled["fn"], ...args: never[]) => { mockScheduled.push({ fn, args }); });
jest.mock("react-native-worklets", () => ({ scheduleOnRN: (...args: Parameters<typeof mockScheduleOnRN>) => mockScheduleOnRN(...args) }));
const inference: OnDeviceInference = {
  vehicles: [{ bbox: [10, 20, 100, 200], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [200, 20, 230, 80], confidence: 0.8, cropBase64: "c2lnbg==" }],
  frameWidth: 1280, frameHeight: 720,
};
const mockDetect = jest.fn(() => inference);
const mockGetCurbVision = jest.fn(() => ({ detect: mockDetect }));
jest.mock("curb-vision", () => ({ getCurbVision: () => mockGetCurbVision() }), { virtual: true });

const context: FrameContext = { lat: 37.8, lng: -122.4, accuracy_m: 3, heading: 180, device_id: "phone", session_id: "capture" };
const accepted: FrameAccepted = {
  frame_id: "frame-1", accepted: true,
  space: {
    id: "spot", zone_id: "zone", location: { type: "Point", coordinates: [-122.4, 37.8] },
    stall_geometry: { type: "Polygon", coordinates: [] }, internal_state: "OPEN",
    last_observed_at: "2026-10-24T21:00:00.000Z", base_confidence: 0.9, version: 1,
  },
};
const mockFetch = jest.fn(async () => ({ ok: true, json: async () => accepted }));
const originalFetch = globalThis.fetch;
const originalUrl = process.env.EXPO_PUBLIC_API_URL;
const originalOS = Platform.OS;
const defaults = { active: true, sampling: true, frameContext: () => context, reduceMotion: true };

function frame() { return { dispose: jest.fn() } as unknown as Frame & { dispose: jest.Mock }; }
async function flushRN() {
  await act(async () => {
    while (mockScheduled.length) { const { fn, args } = mockScheduled.shift()!; fn(...args); }
  });
}
async function emitFrame() {
  const next = frame();
  await act(async () => { mockFrameOptions.onFrame?.(next); });
  return next;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduled.length = 0;
  mockPermission = { hasPermission: true, canRequestPermission: false, status: "authorized", requestPermission: mockRequestPermission };
  mockDevice = { id: "back-camera" };
  mockGetCurbVision.mockImplementation(() => ({ detect: mockDetect }));
  mockDetect.mockImplementation(() => inference);
  mockFetch.mockImplementation(async () => ({ ok: true, json: async () => accepted }));
  process.env.EXPO_PUBLIC_API_URL = "https://curb.test";
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL;
  else process.env.EXPO_PUBLIC_API_URL = originalUrl;
  Object.defineProperty(Platform, "OS", { configurable: true, value: originalOS });
  jest.restoreAllMocks();
});

it("auto-requests not-determined permission only when active", async () => {
  mockPermission = { ...mockPermission, hasPermission: false, canRequestPermission: true, status: "not-determined" };
  const view = await render(<CameraOverlay {...defaults} active={false} />);
  expect(mockRequestPermission).not.toHaveBeenCalled();
  await view.rerender(<CameraOverlay {...defaults} />);
  expect(mockRequestPermission).toHaveBeenCalledTimes(1);
  expect(mockGetCurbVision).not.toHaveBeenCalled();
});

it("offers a permission request after denial when requests remain possible", async () => {
  mockPermission = { ...mockPermission, hasPermission: false, canRequestPermission: true, status: "denied" };
  await render(<CameraOverlay {...defaults} />);
  expect(mockRequestPermission).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("Turn on the camera to share curb sightings."));
  expect(mockRequestPermission).toHaveBeenCalledTimes(1);
});

it("opens Settings for blocked permission", async () => {
  mockPermission = { ...mockPermission, hasPermission: false, status: "denied" };
  const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue();
  await render(<CameraOverlay {...defaults} />);
  await fireEvent.press(screen.getByLabelText("Camera is off. Open Settings to share curb sightings."));
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(mockRequestPermission).not.toHaveBeenCalled();
});

it("shows unavailable hardware without loading native inference or uploading", async () => {
  mockDevice = undefined;
  await render(<CameraOverlay {...defaults} />);
  expect(screen.getByText("Camera unavailable")).toBeTruthy();
  expect(mockGetCurbVision).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("runs iOS native inference with the required output options, schedules JSON, and disposes the frame", async () => {
  const onSpotConfirmed = jest.fn();
  await render(<CameraOverlay {...defaults} onSpotConfirmed={onSpotConfirmed} />);
  expect(screen.getByTestId("native-camera").props).toEqual(expect.objectContaining({ device: mockDevice, isActive: true, outputs: [mockFrameOutput] }));
  expect(mockFrameOptions).toEqual(expect.objectContaining({
    targetResolution: { width: 1280, height: 720 }, pixelFormat: "native", enablePhysicalBufferRotation: true, dropFramesWhileBusy: true,
  }));
  const next = await emitFrame();
  expect(mockDetect).toHaveBeenCalledWith(next);
  expect(next.dispose).toHaveBeenCalledTimes(1);
  expect(mockScheduleOnRN).toHaveBeenCalledWith(expect.any(Function), inference);
  expect(mockFetch).not.toHaveBeenCalled();
  await flushRN();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const [url, request] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://curb.test/v1/vision/detections");
  expect(JSON.parse(request.body as string)).toEqual(expect.objectContaining({
    lat: 37.8, lng: -122.4, heading: 180, device_id: "phone", session_id: "capture", frame_width: 1280, frame_height: 720,
    vehicles: [{ bbox: [10, 20, 100, 200], cls: "car", confidence: 0.9 }],
    signs: [{ bbox: [200, 20, 230, 80], confidence: 0.8, crop_b64: "c2lnbg==" }],
  }));
  expect(onSpotConfirmed).toHaveBeenCalledWith(accepted);
});

it("shows processed detections and moves the single live camera into a full-screen view", async () => {
  await render(<CameraOverlay {...defaults} />);
  await emitFrame();
  await flushRN();

  await act(async () => {
    screen.getByTestId("detection-overlay").props.onLayout({
      nativeEvent: { layout: { width: 128, height: 72 } },
    });
  });
  const detection = screen.getByLabelText("car, 90% confidence");
  expect(detection).toBeTruthy();
  expect(screen.getAllByTestId("native-camera")).toHaveLength(1);
  expect(mockCameraMount).toHaveBeenCalledTimes(1);
  expect(mockCameraUnmount).not.toHaveBeenCalled();
  expect(within(screen.getByLabelText("Expand live camera preview")).queryByLabelText("car, 90% confidence")).toBeNull();

  await fireEvent.press(screen.getByLabelText("Expand live camera preview"));
  expect(screen.getByText("On-device vision")).toBeTruthy();
  expect(screen.getAllByTestId("native-camera")).toHaveLength(1);
  expect(mockCameraMount).toHaveBeenCalledTimes(1);
  expect(mockCameraUnmount).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByLabelText("Close full-screen camera"));
  expect(screen.queryByText("On-device vision")).toBeNull();
  expect(screen.getAllByTestId("native-camera")).toHaveLength(1);
  expect(mockCameraMount).toHaveBeenCalledTimes(1);
  expect(mockCameraUnmount).not.toHaveBeenCalled();
});

it("surfaces a full-screen scanner failure and lets the user stop scanning", async () => {
  function RecoverableCamera() {
    const [sampling, setSampling] = useState(true);
    return <CameraOverlay {...defaults} sampling={sampling} onStopScan={() => setSampling(false)} onStartScan={() => setSampling(true)} />;
  }
  await render(<RecoverableCamera />);
  await fireEvent.press(screen.getByLabelText("Expand live camera preview"));
  mockDetect.mockImplementation(() => { throw new Error("CoreML prediction failed"); });

  await emitFrame();
  await flushRN();

  expect(screen.getByText("Scanner stopped")).toBeTruthy();
  expect(screen.getAllByText("CoreML prediction failed").length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByText("Close and stop scanning"));
  expect(screen.queryByText("On-device vision")).toBeNull();
  expect(screen.getByText("Start Scanning")).toBeTruthy();
});

it("keeps preview active through Stop and Start while toggling inference and submissions", async () => {
  function ToggleCamera() {
    const [sampling, setSampling] = useState(true);
    return <CameraOverlay {...defaults} sampling={sampling} onStopScan={() => setSampling(false)} onStartScan={() => setSampling(true)} />;
  }
  await render(<ToggleCamera />);
  await fireEvent.press(screen.getByText("Stop"));
  expect(screen.getByTestId("native-camera").props).toEqual(expect.objectContaining({ isActive: true, outputs: [] }));
  const next = await emitFrame();
  await flushRN();
  expect(next.dispose).toHaveBeenCalledTimes(1);
  expect(mockDetect).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText("Start Scanning"));
  expect(screen.getByTestId("native-camera").props.outputs).toEqual([mockFrameOutput]);
  await emitFrame();
  await flushRN();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("stops activity and drops queued results across blur/background and restart", async () => {
  const view = await render(<CameraOverlay {...defaults} />);
  await emitFrame(); // RN delivery intentionally delayed until the next scanning session.
  await view.rerender(<CameraOverlay {...defaults} active={false} />);
  expect(screen.getByTestId("native-camera").props).toEqual(expect.objectContaining({ isActive: false, outputs: [] }));
  await emitFrame();
  expect(mockDetect).toHaveBeenCalledTimes(1);
  await view.rerender(<CameraOverlay {...defaults} />);
  await flushRN();
  expect(mockFetch).not.toHaveBeenCalled();
  await emitFrame();
  await flushRN();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("stops uploading on permission loss and suppresses an in-flight confirmation", async () => {
  const pending = deferred<FrameAccepted>();
  mockFetch.mockImplementation(async () => ({ ok: true, json: () => pending.promise }));
  const onSpotConfirmed = jest.fn();
  const view = await render(<CameraOverlay {...defaults} onSpotConfirmed={onSpotConfirmed} />);
  await emitFrame();
  await flushRN();
  mockPermission = { ...mockPermission, hasPermission: false, status: "denied" };
  await view.rerender(<CameraOverlay {...defaults} onSpotConfirmed={onSpotConfirmed} />);
  await act(async () => { pending.resolve(accepted); });
  expect(screen.getByText("Camera off")).toBeTruthy();
  expect(onSpotConfirmed).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("keeps one upload in flight through Stop/Start and uses fresh metadata and callback", async () => {
  const pending = deferred<FrameAccepted>();
  mockFetch.mockImplementationOnce(async () => ({ ok: true, json: () => pending.promise }));
  const oldConfirmation = jest.fn();
  const newConfirmation = jest.fn();
  const view = await render(<CameraOverlay {...defaults} onSpotConfirmed={oldConfirmation} />);
  await emitFrame();
  await flushRN();
  await view.rerender(<CameraOverlay {...defaults} sampling={false} onSpotConfirmed={oldConfirmation} />);
  await view.rerender(<CameraOverlay {...defaults} frameContext={() => ({ ...context, lat: 39 })} onSpotConfirmed={newConfirmation} />);
  await emitFrame();
  await flushRN();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve(accepted); });
  expect(oldConfirmation).not.toHaveBeenCalled();
  expect(newConfirmation).not.toHaveBeenCalled();
  await emitFrame();
  await flushRN();
  expect(JSON.parse((mockFetch.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).lat).toBe(39);
  expect(newConfirmation).toHaveBeenCalledWith(accepted);
});

it.each(["android", "web"])("never loads iOS inference or uploads on %s", async (os) => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
  await render(<CameraOverlay {...defaults} />);
  if (os === "android") {
    expect(screen.getByTestId("native-camera").props.outputs).toEqual([]);
    const next = await emitFrame();
    expect(next.dispose).toHaveBeenCalledTimes(1);
  } else {
    expect(screen.getByText("Camera unavailable")).toBeTruthy();
  }
  await flushRN();
  expect(mockGetCurbVision).not.toHaveBeenCalled();
  expect(mockDetect).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("keeps demo preview-only without loading inference", async () => {
  await render(<CameraOverlay {...defaults} sampling={false} />);
  expect(screen.getByTestId("native-camera").props).toEqual(expect.objectContaining({ isActive: true, outputs: [] }));
  expect(mockGetCurbVision).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("surfaces native model-load failures and leaves a usable preview without empty uploads", async () => {
  mockGetCurbVision.mockImplementation(() => { throw new Error("Missing yolov8s-seg model resource"); });
  await render(<CameraOverlay {...defaults} />);
  expect(screen.getByText("Missing yolov8s-seg model resource")).toBeTruthy();
  expect(screen.getByTestId("native-camera").props).toEqual(expect.objectContaining({ isActive: true, outputs: [] }));
  await emitFrame();
  await flushRN();
  expect(mockDetect).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it("disposes on native throw, shows the error, and stops further inference and submissions", async () => {
  const pending = deferred<FrameAccepted>();
  mockFetch.mockImplementationOnce(async () => ({ ok: true, json: () => pending.promise }));
  const onSpotConfirmed = jest.fn();
  await render(<CameraOverlay {...defaults} onSpotConfirmed={onSpotConfirmed} />);
  await emitFrame();
  await flushRN();
  mockDetect.mockImplementation(() => { throw new Error("CoreML prediction failed"); });
  const failed = await emitFrame();
  expect(failed.dispose).toHaveBeenCalledTimes(1);
  await flushRN();
  expect(screen.getByText("CoreML prediction failed")).toBeTruthy();
  expect(screen.getByTestId("native-camera").props.outputs).toEqual([]);
  const afterFailure = await emitFrame();
  await flushRN();
  expect(afterFailure.dispose).toHaveBeenCalledTimes(1);
  expect(mockDetect).toHaveBeenCalledTimes(2);
  await act(async () => { pending.resolve(accepted); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(onSpotConfirmed).not.toHaveBeenCalled();
});

it("stops on unmount, suppressing queued submissions and pending confirmations", async () => {
  const pending = deferred<FrameAccepted>();
  mockFetch.mockImplementationOnce(async () => ({ ok: true, json: () => pending.promise }));
  const onSpotConfirmed = jest.fn();
  const view = await render(<CameraOverlay {...defaults} onSpotConfirmed={onSpotConfirmed} />);
  await emitFrame();
  await flushRN();
  await emitFrame();
  await view.unmount();
  await flushRN();
  await act(async () => { pending.resolve(accepted); });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(onSpotConfirmed).not.toHaveBeenCalled();
});
