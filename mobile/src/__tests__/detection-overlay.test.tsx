import { act, render, screen } from "@testing-library/react-native";

import type { OnDeviceInference } from "@/api/types";
import { DetectionOverlay } from "@/components/DetectionOverlay";

const populated: OnDeviceInference = {
  vehicles: [{ bbox: [30, 10, 60, 30], cls: "car", confidence: 0.9 }],
  signs: [{ bbox: [65, 5, 75, 20], confidence: 0.8, cropBase64: "c2lnbg==" }],
  frameWidth: 100,
  frameHeight: 50,
};

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
