// Backend contract as the mobile app consumes it, mirroring the MVP spec
// (docs/superpowers/specs/2026-10-23-curb-mvp-design.md, sections 11-13).
// Replace with imports from @curb/contracts once Task 1 lands; field names here
// follow the spec exactly so the swap is mechanical.

export type LngLat = [lng: number, lat: number];
export type GeoPoint = { type: "Point"; coordinates: LngLat };
export type GeoLineString = { type: "LineString"; coordinates: LngLat[] };
export type GeoPolygon = { type: "Polygon"; coordinates: LngLat[][] };

export type DemoProfile = "driver" | "owner";

export type User = {
  id: string;
  display_name: string;
  demo_profile: DemoProfile;
};

export type Session = { user: User; token: string };

export type LegalStatus = "LEGAL" | "ILLEGAL" | "UNKNOWN";

export type CurbZone = {
  id: string;
  /** Curb-face geometry: drawn as-is, no client-side offset. */
  geometry: GeoLineString;
  sign_rule_id: string | null;
  legal_status_now: LegalStatus;
  next_change_at: string | null;
  version: number;
};

export type SpaceState = "UNKNOWN" | "OPEN" | "OCCUPIED";

export type ParkingSpace = {
  id: string;
  zone_id: string;
  location: GeoPoint;
  stall_geometry: GeoPolygon;
  internal_state: SpaceState;
  last_observed_at: string | null;
  base_confidence: number;
  version: number;
};

export type DrivewayState = "UNAVAILABLE" | "AVAILABLE" | "HELD" | "BOOKED";

export type Driveway = {
  id: string;
  owner_id: string;
  location: GeoPoint;
  photo_url: string | null;
  /** Decimal string, e.g. "8.00". */
  price_usdc: string;
  /** Local wall-clock "HH:MM" in availability_timezone. */
  availability_start: string;
  availability_end: string;
  availability_timezone: "America/Los_Angeles";
  /** Live API's dated UTC bounds; wall-clock fields above remain display/edit values. */
  availability_window?: { start: string; end: string };
  state: DrivewayState;
  held_by_user_id: string | null;
  /** The live server's summary of the hold or booking, when there is one. */
  active_booking?: { id: string; state: BookingState; payment_status: string } | null;
  version: number;
};

export type BookingState = "PENDING_PAYMENT" | "PROCESSING" | "RECONCILIATION_REQUIRED" | "CONFIRMED" | "CANCELLED";

export type Booking = {
  id: string;
  idempotency_key: string;
  driveway_id: string;
  driver_id: string;
  state: BookingState;
  amount_usdc: string;
  network: string;
  transaction_hash: string | null;
  created_at: string;
  confirmed_at: string | null;
  version: number;
};

export type Garage = {
  id: string;
  location: GeoPoint;
  lat: number;
  lng: number;
  name: string | null;
  summary: string;
  price: string | null;
  arrow_direction: string | null;
  sign_category: "garage" | "lot";
  version: number;
};

export type NearbyParkingResponse = {
  generated_at: string;
  zones: CurbZone[];
  spaces: ParkingSpace[];
  driveways: Driveway[];
  garages?: Garage[];
};

/** Current-time view of a structured sign rule, as shown in the detail sheet. */
export type SignRuleView = {
  id: string;
  /** Plain-English answer to "can I park here now, and for how long?" */
  summary: string;
  max_minutes: number | null;
  next_change_at: string | null;
  /** What happens at next_change_at, e.g. "No parking (street cleaning)". */
  next_change_summary: string | null;
  payment_text: string | null;
  permit_text: string | null;
  interpretation_confidence: number;
  last_validated_at: string;
};

export type SpaceDetail = {
  space: ParkingSpace;
  /** Replay includes zone geometry; the canonical detail response does not. */
  zone?: CurbZone;
  rule: SignRuleView | null;
};

export type DrivewayUpdate = {
  expected_version: number;
  available: boolean;
  price_usdc: string;
  availability_start: string;
  availability_end: string;
};

export type FrameMetadata = {
  captured_at: string;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  heading: number | null;
  device_id: string;
  session_id: string;
};

export type DetectionBox = [number, number, number, number];
export type VehicleDetectionPayload = { bbox: DetectionBox; cls: string; confidence: number };
export type SignDetectionPayload = { bbox: DetectionBox; confidence: number; crop_b64: string };
export type DetectionSubmission = FrameMetadata & {
  vehicles: VehicleDetectionPayload[];
  signs: SignDetectionPayload[];
  frame_width: number;
  frame_height: number;
};

/** Native inference uses camelCase; convert names once at the HTTP boundary. */
export type OnDeviceInference = {
  vehicles: { bbox: DetectionBox; cls: string; confidence: number }[];
  signs: { bbox: DetectionBox; confidence: number; cropBase64: string }[];
  frameWidth: number;
  frameHeight: number;
};

export type SignFeedback = {
  track_id: number;
  bbox: DetectionBox;
  observations: number;
  required_observations: number;
  state: "gathering" | "unavailable" | "uncertain" | "read";
  reading: {
    signs: { raw_text: string; sign_type?: string }[];
    sign_category?: string;
    combined_summary: string;
    combined_hours: string | null;
    combined_max_duration_min: number | null;
    combined_price: string | null;
    combined_restrictions: string[];
    confidence_score: number;
    flagged: boolean;
  } | null;
};

export type TrackedGap = {
  bbox: DetectionBox;
  left_track_id: number;
  right_track_id: number;
  duration: number;
  confirmed: boolean;
  median_width_meters: number | null;
};

export type FrameAccepted = {
  frame_id: string;
  accepted: boolean;
  pipeline_state?: string;
  vehicle_count?: number;
  gap_count?: number;
  scene_valid?: boolean;
  captured_at?: string;
  frame_width?: number;
  frame_height?: number;
  gap_bboxes?: DetectionBox[];
  tracked_gaps?: TrackedGap[];
  sign_feedback?: SignFeedback[];
  /** Present when the server confirmed a spot from this frame. */
  space?: ParkingSpace;
  zone?: CurbZone;
};

export type RealtimeEventType =
  | "space.opened"
  | "space.refreshed"
  | "space.occupied"
  | "space.expired"
  | "sign_rule.updated"
  | "garage.detected"
  | "driveway.updated"
  | "driveway.held"
  | "driveway.released"
  | "booking.confirmed"
  | "payment.failed";

export type RealtimeEvent = {
  type: RealtimeEventType;
  entity_id: string;
  entity_version: number;
  occurred_at: string;
  payload: Record<string, unknown>;
};

/** Fixed Find radius from the spec: 0.5 miles. */
export const FIND_RADIUS_M = 804.672;

/** Stable seeded IDs shared with the backend fixture. */
export const DEMO_IDS = {
  driver: "driver_demo",
  owner: "owner_demo",
  driveway: "driveway_demo_1",
} as const;

/** The checkout wallet the payment service pays from (spec 7.8). */
export type WalletInfo = {
  network: "base-sepolia";
  payer: { name: string; address: string; usdc_balance: string; explorer_url: string };
  payee: { name: string; address: string };
};

export type PaymentPhase = "approved" | "signed" | "settled" | "confirmed" | "failed" | "reconciliation_required";

export type PaymentProgress = {
  booking_id: string;
  phase: PaymentPhase | null;
  transaction_hash?: string | null;
  explorer_url?: string | null;
  error_code?: string | null;
};
