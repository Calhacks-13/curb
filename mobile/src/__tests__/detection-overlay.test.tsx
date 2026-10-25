import { act, render, screen } from "@testing-library/react-native";

import type { FrameAccepted, OnDeviceInference } from "@/api/types";
import { DetectionOverlay } from "@/components/DetectionOverlay";

const populated: OnDeviceInference = {
  vehicles: [{ bbox: [30, 10, 60, 30], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [65, 5, 75, 20], confidence: 0.8, cropBase64: "c2lnbg==" }],
  frameWidth: 100,
  frameHeight: 50,
};

it("projects the server gap and distinguishes confirmed openings from candidates", async () => {
  const analysis: FrameAccepted = {
    frame_id: "gap", accepted: true, frame_width: 100, frame_height: 50,
    gap_bboxes: [[30, 0, 60, 50], [70, 0, 90, 50]],
    tracked_gaps: [{ bbox: [30, 0, 60, 50], left_track_id: 1, right_track_id: 2, duration: 2.5, confirmed: true, median_width_meters: null }],
  };
  const view = await render(<DetectionOverlay result={populated} analysis={analysis} />);
  await act(async () => screen.getByTestId("detection-overlay").props.onLayout({ nativeEvent: { layout: { width: 100, height: 100 } } }));
  expect(screen.getByLabelText("Gap 1 · Confirmed · 30 px · 2.5s")).toHaveStyle({ left: 10, top: 0, width: 60, height: 100, borderStyle: "solid" });
  expect(screen.getByLabelText("Gap 2 · Candidate · 20 px")).toHaveStyle({ borderStyle: "dashed" });
  await view.rerender(<DetectionOverlay result={populated} analysis={null} />);
  expect(screen.queryByLabelText(/Gap 1/)).toBeNull();
});

it("aligns vehicle and sign boxes with a cover-cropped camera preview", async () => {
  await render(<DetectionOverlay result={populated} />);

  await act(async () => {
    screen.getByTestId("detection-overlay").props.onLayout({
      nativeEvent: { layout: { width: 100, height: 100 } },
    });
  });

  expect(screen.getByLabelText("car, 90% confidence")).toHaveStyle({
    left: 10,
    top: 20,
    width: 60,
    height: 40,
  });
  expect(screen.getByLabelText("parking sign, 80% confidence")).toHaveStyle({
    left: 80,
    top: 10,
    width: 20,
    height: 30,
  });
  expect(screen.getByText("1 vehicle · 1 sign")).toBeTruthy();
});

it("clears stale boxes when the latest processed frame has no detections", async () => {
  const view = await render(<DetectionOverlay result={populated} />);
  await act(async () => {
    screen.getByTestId("detection-overlay").props.onLayout({
      nativeEvent: { layout: { width: 100, height: 100 } },
    });
  });
  expect(screen.getByLabelText("car, 90% confidence")).toBeTruthy();

  await view.rerender(
    <DetectionOverlay result={{ vehicles: [], signs: [], frameWidth: 100, frameHeight: 50 }} />,
  );

  expect(screen.queryByLabelText("car, 90% confidence")).toBeNull();
  expect(screen.getByText("No detections")).toBeTruthy();
});

it.each([
  { viewport: { width: 50, height: 100 }, expected: { left: -15, top: 20, width: 60, height: 40 } },
  { viewport: { width: 100, height: 25 }, expected: { left: 30, top: -2.5, width: 30, height: 20 } },
])("reprojects boxes after a $viewport.width × $viewport.height relayout", async ({ viewport, expected }) => {
  await render(<DetectionOverlay result={populated} />);

  await act(async () => {
    screen.getByTestId("detection-overlay").props.onLayout({ nativeEvent: { layout: viewport } });
  });

  expect(screen.getByLabelText("car, 90% confidence")).toHaveStyle(expected);
});
