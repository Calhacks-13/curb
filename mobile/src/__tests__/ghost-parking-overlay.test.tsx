import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { GhostParkingOverlay } from "@/components/GhostParkingOverlay";

jest.mock("expo", () => ({ requireNativeView: () => {
  const { View } = require("react-native");
  return function NativeGhost(props: object) { return <View {...props} testID="native-ghost" />; };
} }));
const inference: OnDeviceInference = { frameWidth: 1000, frameHeight: 600, signs: [], vehicles: [
  { bbox: [0, 200, 250, 500], cls: "car", confidence: 0.5 },
  { bbox: [700, 200, 1000, 500], cls: "car", confidence: 0.5 },
] };
const analysis: FrameAccepted = { frame_id: "1", accepted: true, frame_width: 1000, frame_height: 600,
  gap_bboxes: [[250, 0, 700, 600]], tracked_gaps: [{ bbox: [250, 0, 700, 600], left_track_id: 1, right_track_id: 2,
    confirmed: true, duration: 3, median_width_meters: null }] };
async function layout() {
  await act(async () => screen.getByTestId("ghost-parking-overlay").props.onLayout({ nativeEvent: { layout: { width: 1000, height: 600 } } }));
}
it("mounts the native-view boundary and reports its first rendered frame", async () => {
  const onStatus = jest.fn();
  const view = await render(<GhostParkingOverlay inference={inference} analysis={analysis} compact={false} onStatusChange={onStatus} />);
  await layout();
  expect(screen.getByTestId("native-ghost")).toBeTruthy();
  expect(onStatus).toHaveBeenLastCalledWith("Loading 3D model");
  await fireEvent(screen.getByTestId("native-ghost"), "status", { nativeEvent: { state: "rendered" } });
  expect(onStatus).toHaveBeenLastCalledWith("3D model rendered");
  await view.rerender(<GhostParkingOverlay inference={{ ...inference, vehicles: [] }} analysis={analysis} compact={false} onStatusChange={onStatus} />);
  expect(screen.queryByTestId("native-ghost")).toBeNull();
  expect(onStatus).toHaveBeenLastCalledWith("Keep both neighboring cars in view");
});
it("reports a native model-load failure instead of silently showing an empty opening", async () => {
  const onStatus = jest.fn();
  await render(<GhostParkingOverlay inference={inference} analysis={analysis} compact={false} onStatusChange={onStatus} />);
  await layout();
  await fireEvent(screen.getByTestId("native-ghost"), "status", { nativeEvent: { state: "error" } });
  expect(onStatus).toHaveBeenLastCalledWith("3D model unavailable — reopen the updated app");
});
