import { fireEvent, render, screen } from "@testing-library/react-native";

import type { FrameAccepted, OnDeviceInference, SignFeedback } from "@/api/types";
import { ScannerExperience } from "@/components/ScannerExperience";
import { isParkingReading, scannerPresentation } from "@/features/capture/scannerPresentation";

const inference: OnDeviceInference = { frameWidth: 1080, frameHeight: 1920, vehicles: [], signs: [
  { bbox: [100, 100, 200, 300], confidence: 0.8, cropBase64: "crop" },
] };
const sign: SignFeedback = {
  track_id: 1, bbox: [100, 100, 200, 300], observations: 3, required_observations: 3, state: "read",
  reading: { signs: [{ sign_type: "no_parking", raw_text: "NO PARKING 11 AM TO 1 PM 3RD TUESDAY STREET CLEANING" }],
    sign_category: "street", combined_summary: "No parking 11am–1pm on the third Tuesday of each month.",
    combined_hours: "11am–1pm, third Tuesday", combined_max_duration_min: null, combined_price: null,
    combined_restrictions: ["street cleaning"], confidence_score: 0.85, flagged: false },
};
const analysis: FrameAccepted = { frame_id: "frame", accepted: true, gap_bboxes: [[100, 0, 600, 1920]],
  tracked_gaps: [{ bbox: [100, 0, 600, 1920], left_track_id: 1, right_track_id: 2, duration: 3, confirmed: true, median_width_meters: null }],
  sign_feedback: [sign] };
const context = { running: true, inference, analysis, fresh: true, uploadFailed: false, error: null };
const props = { presentation: scannerPresentation(context), sign, previousSign: false, sampling: true,
  diagnostics: false, reduceMotion: true, error: null, onPause: jest.fn(), onStart: jest.fn(), onCloseError: jest.fn(), onToggleDiagnostics: jest.fn() };

it("shows readable observations and sign rules while keeping scores and raw text out of the main view", async () => {
  await render(<ScannerExperience {...props} />);
  expect(screen.queryByText("An opening is visible.")).toBeNull();
  expect(screen.getByText("Parking preview")).toBeTruthy();
  expect(screen.getByText("0 cars · 1 opening · 1 sign")).toBeTruthy();
  expect(screen.getByText(sign.reading!.combined_summary)).toBeTruthy();
  expect(screen.queryByText(/85%|track_id|Server received/)).toBeNull();
  expect(screen.queryByText(sign.reading!.signs[0].raw_text)).toBeNull();
  await fireEvent.press(screen.getByLabelText("Read full sign text"));
  expect(screen.getByText(sign.reading!.signs[0].raw_text)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Hide sign text"));
  expect(screen.queryByText(sign.reading!.signs[0].raw_text)).toBeNull();
});

it("keeps a previous sign available on request without presenting it as the current curb rule", async () => {
  await render(<ScannerExperience {...props} previousSign />);
  expect(screen.queryByText(sign.reading!.combined_summary)).toBeNull();
  await fireEvent.press(screen.getByLabelText("View last parking sign"));
  expect(screen.getByText("LAST PARKING SIGN")).toBeTruthy();
  expect(screen.getByText("From an earlier observation")).toBeTruthy();
  expect(screen.getByText(sign.reading!.combined_summary)).toBeTruthy();
});

it("never claims an opening reached the map without a legal zone and returned spot", () => {
  expect(scannerPresentation(context).title).toBe("An opening is visible.");
  const updated = { ...analysis, space: { id: "spot" }, zone: { legal_status_now: "UNKNOWN" } } as FrameAccepted;
  expect(scannerPresentation({ ...context, analysis: updated }).title).toBe("An opening is visible.");
  expect(scannerPresentation({ ...context, analysis: { ...updated, zone: { legal_status_now: "LEGAL" } } as FrameAccepted }).title).toBe("An opening, on the map.");
  expect(scannerPresentation({ ...context, fresh: false }).title).toBe("Refreshing your view");
});

it("explains a lost connection without implying scanning stopped or observations were queued", async () => {
  await render(<ScannerExperience {...props} sign={null} presentation={scannerPresentation({ ...context, uploadFailed: true })} />);
  expect(screen.getByText("Reconnecting")).toBeTruthy();
  expect(screen.getByText(/Your camera is working/)).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Pause scanning"));
  expect(props.onPause).toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText("Show diagnostics"));
  expect(props.onToggleDiagnostics).toHaveBeenCalled();
});

it("rejects informational street names and uncertain OCR as parking-rule cards", () => {
  const street = { ...sign, reading: { ...sign.reading!, sign_category: "informational", signs: [{ sign_type: "directional", raw_text: "LYON" }] } };
  expect(isParkingReading(street)).toBe(false);
  expect(scannerPresentation({ ...context, analysis: { ...analysis, gap_bboxes: [], tracked_gaps: [], sign_feedback: [street] } }).title).toBe("Look for the parking rules.");
  expect(isParkingReading({ ...sign, state: "uncertain", reading: { ...sign.reading!, flagged: true } })).toBe(false);
  expect(isParkingReading(sign)).toBe(true);
});
