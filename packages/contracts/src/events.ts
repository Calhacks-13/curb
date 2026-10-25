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
  z.strictObject({
    type: z.literal("space.opened"),
    ...eventBase,
    payload: z.strictObject({ space: ParkingSpaceViewSchema }),
  }),
  z.strictObject({
    type: z.literal("space.refreshed"),
    ...eventBase,
    payload: z.strictObject({ space: ParkingSpaceViewSchema }),
  }),
  z.strictObject({
    type: z.literal("space.occupied"),
    ...eventBase,
    payload: z.strictObject({ space_id: z.string().min(1) }),
  }),
  z.strictObject({
    type: z.literal("space.expired"),
    ...eventBase,
    payload: z.strictObject({ space_id: z.string().min(1) }),
  }),
  z.strictObject({
    type: z.literal("sign_rule.updated"),
    ...eventBase,
    payload: z.strictObject({
      zone_id: z.string().min(1),
      sign_rule: SignRuleViewSchema,
    }),
  }),
  z.strictObject({
    type: z.literal("driveway.updated"),
    ...eventBase,
    payload: z.strictObject({ driveway: DrivewayViewSchema }),
  }),
  z.strictObject({
    type: z.literal("driveway.held"),
    ...eventBase,
    payload: z.strictObject({ driveway: DrivewayViewSchema }),
  }),
  z.strictObject({
    type: z.literal("driveway.released"),
    ...eventBase,
    payload: z.strictObject({ driveway: DrivewayViewSchema }),
  }),
  z.strictObject({
    type: z.literal("booking.confirmed"),
    ...eventBase,
    payload: z.strictObject({
      booking: BookingViewSchema,
      driveway: DrivewayViewSchema,
    }),
  }),
  z.strictObject({
    type: z.literal("payment.failed"),
    ...eventBase,
    payload: z.strictObject({
      booking_id: z.string().min(1),
      code: z.string().min(1),
      retryable: z.boolean(),
    }),
  }),
  z.strictObject({
    type: z.literal("agent.position"),
    ...eventBase,
    payload: z.strictObject({
      position: z.tuple([
        z.number().finite().min(-180).max(180),
        z.number().finite().min(-90).max(90),
      ]),
      heading: z.number().finite().min(0).lt(360),
    }),
  }),
]);

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;
