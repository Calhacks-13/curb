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

export const DemoSessionRequestSchema = z.object({ profile: DemoProfileSchema });
export const DemoSessionResponseSchema = z.object({
  user: UserViewSchema,
  token: z.string().min(1),
});

export const NearbyParkingQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius_m: z.coerce
    .number()
    .refine((value) => value === 804.672, "mobile nearby radius must be 804.672 meters"),
});
export { NearbyParkingResponseSchema, SpaceDetailSchema };

export const RealtimeNegotiateResponseSchema = z.object({ url: z.string().url() });

export const VisionFrameMetadataSchema = z.object({
  timestamp: UtcDateTimeSchema,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  location_accuracy: z.number().nonnegative(),
  heading: z.number().min(0).lt(360),
  device_id: z.string().min(1),
  session_id: z.string().min(1),
});
export const VisionFrameAcceptedSchema = z.object({
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
  .refine((value) => value.availability_start < value.availability_end, {
    message: "availability_start must precede availability_end",
    path: ["availability_end"],
  });

export const CreateHoldRequestSchema = z.object({
  expected_version: z.number().int().positive(),
});
export const ReleaseHoldRequestSchema = z.object({}).strict();
export const RecoverDrivewayRequestSchema = CreateHoldRequestSchema;

export const PaymentProcessingRequestSchema = z.object({
  expected_booking_version: z.number().int().positive(),
});
export const FinalizeBookingRequestSchema = z.object({
  idempotency_key: z.string().min(1),
  transaction_hash: z.string().min(1),
  expected_booking_version: z.number().int().positive(),
});
export const PaymentFailedRequestSchema = z.object({
  code: z.string().min(1),
  retryable: z.boolean(),
});

export const BookingAndDrivewayResponseSchema = z.object({
  booking: BookingViewSchema,
  driveway: DrivewayViewSchema,
});
export const ExecutePaymentResponseSchema = BookingAndDrivewayResponseSchema.extend({
  explorer_url: z.string().url(),
});

export const X402BookingReceiptSchema = z.object({
  booking_id: z.string().min(1),
  driveway_id: z.string().min(1),
  amount_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  network: NetworkSchema,
  payee_address: z.string().min(1),
});

export const AgentParkingSearchRequestSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().positive(),
});
export const AgentParkingSearchResponseSchema = z.object({
  generated_at: UtcDateTimeSchema,
  options: z.array(AgentParkingOptionSchema).max(3),
});

export const RouteDestinationSchema = z.object({
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
