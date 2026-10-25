import type { FrameAccepted, OnDeviceInference, SignFeedback } from "@/api/types";
import type { DeepReadonly } from "./DetectionUploadController";

export type ScannerAnalysis = DeepReadonly<FrameAccepted>;
export type ScannerSign = DeepReadonly<SignFeedback>;

/** A detected street-name plate is readable text, but never a curb regulation. */
export function isParkingReading(sign: ScannerSign): boolean {
  const reading = sign.reading;
  return sign.state === "read" && !!reading && !reading.flagged && reading.confidence_score >= 0.5
    && (!reading.sign_category || reading.sign_category === "street")
    && reading.signs.some((item) => /parking|street\s+clean|permit|meter|loading|\bhours?\b/i.test(item.raw_text));
}

type Context = {
  running: boolean;
  inference: OnDeviceInference | null;
  analysis: ScannerAnalysis | null;
  fresh: boolean;
  uploadFailed: boolean;
  error: string | null;
};

export function scannerPresentation({ running, inference, analysis, fresh, uploadFailed, error }: Context) {
  const gaps = fresh ? analysis?.gap_bboxes ?? [] : [];
  const confirmed = gaps.filter((box) => analysis?.tracked_gaps?.some(
    (gap) => gap.confirmed && gap.bbox.every((value, axis) => value === box[axis]),
  )).length;
  const rules = analysis?.sign_feedback?.some(isParkingReading) ?? false;
  const informational = analysis?.sign_feedback?.some((sign) => sign.reading?.sign_category === "informational") ?? false;
  const unavailable = analysis?.sign_feedback?.some((sign) => sign.state === "unavailable") ?? false;
  const observing = !!inference && inference.vehicles.length + inference.signs.length > 0;
  let title = "Finding the curb";
  let detail = "Keep parked cars and nearby signs in view.";
  let compact = "Scanning curb";
  let badge = "Live scan";
  let tone: "neutral" | "positive" | "attention" = "neutral";
  if (error) {
    title = "Scanner stopped"; detail = error; compact = "Scanner paused"; badge = "Paused"; tone = "attention";
  } else if (!running) {
    title = "Ready when you are"; detail = "Point toward the curb, then start your scan."; compact = "Camera preview"; badge = "Preview";
  } else if (uploadFailed) {
    title = "Still looking. Sync paused."; detail = "Your camera is working. Map updates resume when the connection returns.";
    compact = "Waiting to connect"; badge = "Reconnecting"; tone = "attention";
  } else if (!inference) {
    title = "Getting a clear view"; detail = "Hold the camera toward parked cars for a moment."; badge = "Starting";
  } else if (!analysis) {
    title = "Taking a closer look"; detail = "Scanning the curb and connecting your observations."; compact = "Taking a closer look"; badge = "Syncing";
  } else if (!fresh) {
    title = "Refreshing your view"; detail = "Keep the curb in view while the latest observations arrive.";
    compact = "Refreshing view"; badge = "Syncing";
  } else if (confirmed > 0) {
    const mapped = !!analysis.space && analysis.zone?.legal_status_now === "LEGAL";
    title = mapped ? "An opening, on the map." : "An opening is visible.";
    detail = mapped ? "Seen open just now. The map has your latest observation." : informational
      ? "Space observed. Point toward a posted parking sign to check the rules." : "Space observed. We’re checking the posted parking rules.";
    compact = "Opening observed"; tone = "positive";
  } else if (gaps.length) {
    title = "This could be a space."; detail = "Keep it in view for a moment so we can confirm the opening.";
    compact = "Checking a space";
  } else if (inference.signs.length) {
    const uncertain = analysis.sign_feedback?.some((sign) => sign.state === "uncertain");
    title = uncertain ? "A clearer sign will help." : rules ? "The sign is read." : "Reading the sign.";
    detail = uncertain ? "Move closer and hold steady. The text needs a clearer view." : rules ? "The parking rules are ready below." : "Hold the sign in view while we read the details.";
    compact = uncertain ? "Clearer view needed" : "Reading a sign";
    if (informational && !rules) {
      title = "Look for the parking rules."; detail = "This sign has no curb restrictions. Try a posted parking sign nearby."; compact = "Find a parking sign";
    }
    if (unavailable) {
      title = "Sign reading is unavailable."; detail = "We can still look for openings. Sign interpretation is temporarily unavailable.";
      compact = "Sign reading paused"; tone = "attention";
    }
  } else if (observing) {
    title = "Following the curb."; detail = "Looking for openings between the parked cars.";
  }
  return { title, detail, compact, badge, tone, observing, confirmed, candidateCount: gaps.length, rules,
    vehicleCount: inference?.vehicles.length ?? 0, signCount: inference?.signs.length ?? 0 };
}

export type ScannerPresentation = ReturnType<typeof scannerPresentation>;
