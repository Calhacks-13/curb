import { z } from "zod";

import {
  AgentParkingOptionSchema,
  BookingViewSchema,
  DemoProfileSchema,
  DrivewayViewSchema,
  GeoPointSchema,
  NearbyParkingResponseSchema,
  NetworkSchema,
  SpaceDetailSchema,
  UtcDateTimeSchema,
  UserViewSchema,
} from "./domain.js";

export const DemoSessionRequestSchema = z.strictObject({ profile: DemoProfileSchema });
export const DemoSessionResponseSchema = z.strictObject({
  user: UserViewSchema,
  token: z.string().min(1),
});

export const NearbyParkingQuerySchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z
    .number()
    .refine((value) => value === 804.672, "mobile nearby radius must be 804.672 meters"),
});
export { NearbyParkingResponseSchema, SpaceDetailSchema };

export const SecureWebSocketUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === "wss:", "URL must use wss://");
export const RealtimeNegotiateResponseSchema = z.strictObject({
  url: SecureWebSocketUrlSchema,
});

export const VisionFrameMetadataSchema = z.strictObject({
  timestamp: UtcDateTimeSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  location_accuracy: z.number().nonnegative(),
  heading: z.number().min(0).lt(360),
  device_id: z.string().min(1),
  session_id: z.string().min(1),
});
export const VisionFrameAcceptedSchema = z.strictObject({
  frame_id: z.string().min(1),
  accepted: z.boolean(),
});

export const DrivewayUpdateRequestSchema = z
  .object({
    expected_version: z.number().int().positive(),
    available: z.boolean(),
    price_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
    availability_start: UtcDateTimeSchema,
    availability_end: UtcDateTimeSchema,
  })
  .refine(
    (value) => Date.parse(value.availability_start) < Date.parse(value.availability_end),
    {
    message: "availability_start must precede availability_end",
    path: ["availability_end"],
    },
  );

export const CreateHoldRequestSchema = z.strictObject({
  expected_version: z.number().int().positive(),
});
export const ReleaseHoldRequestSchema = z.strictObject({}).strict();
export const RecoverDrivewayRequestSchema = CreateHoldRequestSchema;

export const PaymentProcessingRequestSchema = z.strictObject({
  expected_booking_version: z.number().int().positive(),
});
export const FinalizeBookingRequestSchema = z.strictObject({
  idempotency_key: z.string().min(1),
  transaction_hash: z.string().min(1),
  expected_booking_version: z.number().int().positive(),
});
export const PaymentFailedRequestSchema = z.strictObject({
  expected_booking_version: z.number().int().positive(),
  code: z.string().min(1),
  retryable: z.boolean(),
});

export const BookingAndDrivewayResponseSchema = z.strictObject({
  booking: BookingViewSchema,
  driveway: DrivewayViewSchema,
});
export const ExecutePaymentResponseSchema = BookingAndDrivewayResponseSchema.extend({
  explorer_url: z.string().url(),
});

export const X402BookingReceiptSchema = z.strictObject({
  booking_id: z.string().min(1),
  driveway_id: z.string().min(1),
  amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  network: NetworkSchema,
  payee_address: z.string().min(1),
});

export const AgentParkingSearchRequestSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().positive(),
});
export const AgentParkingSearchResponseSchema = z.strictObject({
  generated_at: UtcDateTimeSchema,
  options: z.array(AgentParkingOptionSchema).max(3),
});

export const RouteDestinationSchema = z.strictObject({
  destination: GeoPointSchema,
});

export type DemoSessionRequest = z.infer<typeof DemoSessionRequestSchema>;
export type DemoSessionResponse = z.infer<typeof DemoSessionResponseSchema>;
export type NearbyParkingQuery = z.infer<typeof NearbyParkingQuerySchema>;
export type RealtimeNegotiateResponse = z.infer<typeof RealtimeNegotiateResponseSchema>;
export type VisionFrameMetadata = z.infer<typeof VisionFrameMetadataSchema>;
export type VisionFrameAccepted = z.infer<typeof VisionFrameAcceptedSchema>;
export type DrivewayUpdateRequest = z.infer<typeof DrivewayUpdateRequestSchema>;
export type CreateHoldRequest = z.infer<typeof CreateHoldRequestSchema>;
export type PaymentProcessingRequest = z.infer<typeof PaymentProcessingRequestSchema>;
export type FinalizeBookingRequest = z.infer<typeof FinalizeBookingRequestSchema>;
export type PaymentFailedRequest = z.infer<typeof PaymentFailedRequestSchema>;
export type BookingAndDrivewayResponse = z.infer<typeof BookingAndDrivewayResponseSchema>;
export type ExecutePaymentResponse = z.infer<typeof ExecutePaymentResponseSchema>;
export type X402BookingReceipt = z.infer<typeof X402BookingReceiptSchema>;
export type AgentParkingSearchRequest = z.infer<typeof AgentParkingSearchRequestSchema>;
export type AgentParkingSearchResponse = z.infer<typeof AgentParkingSearchResponseSchema>;
