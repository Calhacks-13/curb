import { z } from "zod";

const UTC_SUFFIX = /(Z|[+-]00:00)$/;

export const UtcDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => UTC_SUFFIX.test(value), "timestamp must use UTC");

export const LongitudeSchema = z.number().min(-180).max(180);
export const LatitudeSchema = z.number().min(-90).max(90);
export const LngLatSchema = z.tuple([LongitudeSchema, LatitudeSchema]);

export const GeoPointSchema = z.strictObject({
  type: z.literal("Point"),
  coordinates: LngLatSchema,
});

export const GeoLineStringSchema = z.strictObject({
  type: z.literal("LineString"),
  coordinates: z.array(LngLatSchema).min(2),
});

export const GeoPolygonSchema = z.strictObject({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(LngLatSchema).min(4)).min(1),
});

export const DemoProfileSchema = z.enum(["driver", "owner"]);
export const LegalStatusSchema = z.enum(["LEGAL", "ILLEGAL", "UNKNOWN"]);
export const InternalSpaceStateSchema = z.enum(["UNKNOWN", "OPEN", "OCCUPIED"]);
export const OccupancySchema = z.enum(["OPEN", "OCCUPIED", "UNKNOWN"]);
export const FreshnessSchema = z.enum(["FRESH", "AGING", "STALE"]);
export const DrivewayStateSchema = z.enum(["UNAVAILABLE", "AVAILABLE", "HELD", "BOOKED"]);
export const BookingStateSchema = z.enum([
  "PENDING_PAYMENT",
  "PROCESSING",
  "RECONCILIATION_REQUIRED",
  "CONFIRMED",
  "CANCELLED",
]);
export const PaymentStatusSchema = z.enum(["NOT_STARTED", "PROCESSING", "FAILED", "SETTLED"]);
export const NetworkSchema = z.literal("base-sepolia");
export const DayOfWeekSchema = z.enum([
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
]);
export const RuleKindSchema = z.enum([
  "ALLOWED",
  "NO_PARKING",
  "STREET_CLEANING",
  "PERMIT_ONLY",
  "METERED",
]);

export const WeeklyRuleWindowSchema = z.strictObject({
  days: z.array(DayOfWeekSchema).min(1),
  start_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end_local: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  kind: RuleKindSchema,
});

export const PaymentRulesSchema = z.strictObject({
  required: z.boolean(),
  price_text: z.string().nullable(),
});

export const PermitRulesSchema = z.strictObject({
  required: z.boolean(),
  permitted_labels: z.array(z.string()),
});

export const UserViewSchema = z.strictObject({
  id: z.string().min(1),
  display_name: z.string().min(1),
  demo_profile: DemoProfileSchema,
});

export const SignRuleViewSchema = z.strictObject({
  id: z.string().min(1),
  zone_id: z.string().min(1),
  weekly_schedule: z.array(WeeklyRuleWindowSchema),
  max_minutes: z.number().int().positive().nullable(),
  payment_rules: PaymentRulesSchema,
  permit_rules: PermitRulesSchema,
  exceptions: z.array(z.string()),
  evidence_text: z.string().min(1),
  interpretation_confidence: z.number().min(0).max(1),
  last_validated_at: UtcDateTimeSchema,
  version: z.number().int().positive(),
});

export const CurbZoneViewSchema = z.strictObject({
  id: z.string().min(1),
  geometry: GeoLineStringSchema,
  sign_rule_id: z.string().min(1).nullable(),
  legal_status_now: LegalStatusSchema,
  current_rules: z.string().min(1),
  next_change_at: UtcDateTimeSchema.nullable(),
  version: z.number().int().positive(),
});

export const ParkingSpaceViewSchema = z.strictObject({
  id: z.string().min(1),
  zone_id: z.string().min(1),
  location: GeoPointSchema,
  stall_geometry: GeoPolygonSchema,
  internal_state: InternalSpaceStateSchema,
  last_observed_at: UtcDateTimeSchema.nullable(),
  base_confidence: z.number().min(0).max(1),
  detection_confidence: z.number().min(0).max(1).default(0),
  freshness: FreshnessSchema.nullable(),
  status_label: z.string().min(1),
  distance_m: z.number().nonnegative(),
  version: z.number().int().positive(),
});

export const ActiveBookingSummarySchema = z.strictObject({
  id: z.string().min(1),
  state: BookingStateSchema,
  payment_status: PaymentStatusSchema,
});

export const SpaceDetailSchema = ParkingSpaceViewSchema.extend({
  sign_rule: SignRuleViewSchema,
  current_rules: z.string().min(1),
  max_minutes: z.number().int().positive().nullable(),
  next_change_at: UtcDateTimeSchema.nullable(),
});

export const DrivewayViewSchema = z
  .strictObject({
    id: z.string().min(1),
    owner_id: z.string().min(1),
    location: GeoPointSchema,
    photo_url: z.string().url(),
    price_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
    availability_start: UtcDateTimeSchema,
    availability_end: UtcDateTimeSchema,
    availability_timezone: z.literal("America/Los_Angeles"),
    state: DrivewayStateSchema,
    held_by_user_id: z.string().min(1).nullable(),
    active_booking: ActiveBookingSummarySchema.nullable(),
    available_now: z.boolean(),
    distance_m: z.number().nonnegative(),
    version: z.number().int().positive(),
  })
  .superRefine((value, context) => {
    if (value.state === "HELD" && value.active_booking === null) {
      context.addIssue({
        code: "custom",
        path: ["active_booking"],
        message: "held driveways require an active booking",
      });
    }
    if (["UNAVAILABLE", "AVAILABLE"].includes(value.state) && value.active_booking !== null) {
      context.addIssue({
        code: "custom",
        path: ["active_booking"],
        message: "unheld driveways cannot expose an active booking",
      });
    }
  });

export const BookingViewSchema = z.strictObject({
  id: z.string().min(1),
  idempotency_key: z.string().min(1),
  driveway_id: z.string().min(1),
  driver_id: z.string().min(1),
  state: BookingStateSchema,
  payment_status: PaymentStatusSchema,
  amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  network: NetworkSchema,
  transaction_hash: z.string().min(1).nullable(),
  created_at: UtcDateTimeSchema,
  confirmed_at: UtcDateTimeSchema.nullable(),
  version: z.number().int().positive(),
});

export const ObservationSchema = z.strictObject({
  id: z.string().min(1),
  space_id: z.string().min(1),
  session_id: z.string().min(1),
  observed_at: UtcDateTimeSchema,
  occupancy: OccupancySchema,
  detection_confidence: z.number().min(0).max(1),
  location_accuracy: z.number().nonnegative(),
  heading: z.number().min(0).lt(360),
  model_version: z.string().min(1),
});

export const NearbyParkingResponseSchema = z.strictObject({
  generated_at: UtcDateTimeSchema,
  zones: z.array(CurbZoneViewSchema),
  spaces: z.array(ParkingSpaceViewSchema),
  driveways: z.array(DrivewayViewSchema),
});

export const ParkingOptionTypeSchema = z.enum(["CURB", "DRIVEWAY"]);
export const AgentParkingOptionSchema = z.strictObject({
  id: z.string().min(1),
  type: ParkingOptionTypeSchema,
  location: GeoPointSchema,
  distance_m: z.number().nonnegative(),
  price_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/).nullable(),
  current_rules: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  freshness: FreshnessSchema.nullable(),
  availability: z.string().min(1),
  reservation_supported: z.boolean(),
});

export const PublicSeedFixtureSchema = z.strictObject({
  driver: UserViewSchema,
  owner: UserViewSchema,
  sign_rule: SignRuleViewSchema,
  driveway: DrivewayViewSchema,
  booking: BookingViewSchema,
  nearby: NearbyParkingResponseSchema,
  agent_option: AgentParkingOptionSchema,
});

export type GeoPoint = z.infer<typeof GeoPointSchema>;
export type DemoProfile = z.infer<typeof DemoProfileSchema>;
export type UserView = z.infer<typeof UserViewSchema>;
export type SignRuleView = z.infer<typeof SignRuleViewSchema>;
export type CurbZoneView = z.infer<typeof CurbZoneViewSchema>;
export type ParkingSpaceView = z.infer<typeof ParkingSpaceViewSchema>;
export type SpaceDetail = z.infer<typeof SpaceDetailSchema>;
export type DrivewayView = z.infer<typeof DrivewayViewSchema>;
export type ActiveBookingSummary = z.infer<typeof ActiveBookingSummarySchema>;
export type BookingView = z.infer<typeof BookingViewSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type NearbyParkingResponse = z.infer<typeof NearbyParkingResponseSchema>;
export type AgentParkingOption = z.infer<typeof AgentParkingOptionSchema>;
export type PublicSeedFixture = z.infer<typeof PublicSeedFixtureSchema>;
