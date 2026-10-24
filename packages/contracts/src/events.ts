import { z } from "zod";

import {
  BookingViewSchema,
  DrivewayViewSchema,
  ParkingSpaceViewSchema,
  SignRuleViewSchema,
  UtcDateTimeSchema,
} from "./domain.js";

const eventBase = {
  entity_id: z.string().min(1),
  entity_version: z.number().int().positive(),
  occurred_at: UtcDateTimeSchema,
};

export const RealtimeEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("space.opened"),
    ...eventBase,
    payload: z.object({ space: ParkingSpaceViewSchema }),
  }),
  z.object({
    type: z.literal("space.refreshed"),
    ...eventBase,
    payload: z.object({ space: ParkingSpaceViewSchema }),
  }),
  z.object({
    type: z.literal("space.occupied"),
    ...eventBase,
    payload: z.object({ space_id: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("space.expired"),
    ...eventBase,
    payload: z.object({ space_id: z.string().min(1) }),
  }),
  z.object({
    type: z.literal("sign_rule.updated"),
    ...eventBase,
    payload: z.object({
      zone_id: z.string().min(1),
      sign_rule: SignRuleViewSchema,
    }),
  }),
  z.object({
    type: z.literal("driveway.updated"),
    ...eventBase,
    payload: z.object({ driveway: DrivewayViewSchema }),
  }),
  z.object({
    type: z.literal("driveway.held"),
    ...eventBase,
    payload: z.object({ driveway: DrivewayViewSchema }),
  }),
  z.object({
    type: z.literal("driveway.released"),
    ...eventBase,
    payload: z.object({ driveway: DrivewayViewSchema }),
  }),
  z.object({
    type: z.literal("booking.confirmed"),
    ...eventBase,
    payload: z.object({
      booking: BookingViewSchema,
      driveway: DrivewayViewSchema,
    }),
  }),
  z.object({
    type: z.literal("payment.failed"),
    ...eventBase,
    payload: z.object({
      booking_id: z.string().min(1),
      code: z.string().min(1),
      retryable: z.boolean(),
    }),
  }),
]);

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
