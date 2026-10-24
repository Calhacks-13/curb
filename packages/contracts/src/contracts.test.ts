import { describe, expect, it } from "vitest";

import {
  AgentParkingSearchResponseSchema,
  DemoSessionResponseSchema,
  DrivewayUpdateRequestSchema,
  NearbyParkingQuerySchema,
  PaymentFailedRequestSchema,
  RealtimeNegotiateResponseSchema,
} from "./api.js";
import { NearbyParkingResponseSchema, PublicSeedFixtureSchema } from "./domain.js";
import { RealtimeEventSchema } from "./events.js";
import { PUBLIC_SEED_FIXTURE } from "./fixtures.js";

describe("shared contracts", () => {
  it("accepts the deterministic public seed through its public response schemas", () => {
    const seed = PublicSeedFixtureSchema.parse(PUBLIC_SEED_FIXTURE);

    expect(NearbyParkingResponseSchema.parse(seed.nearby)).toEqual(seed.nearby);
    expect(
      DemoSessionResponseSchema.parse({ user: seed.driver, token: "driver-demo-token" }),
    ).toEqual({ user: seed.driver, token: "driver-demo-token" });
  });

  it("rejects latitude-longitude coordinates where longitude-latitude is required", () => {
    const swapped = structuredClone(PUBLIC_SEED_FIXTURE);
    swapped.nearby.spaces[0].location.coordinates = [37.79, -122.4];

    expect(() => PublicSeedFixtureSchema.parse(swapped)).toThrow();
  });

  it("rejects timestamps without a UTC offset", () => {
    const localTimestamp = structuredClone(PUBLIC_SEED_FIXTURE);
    localTimestamp.nearby.generated_at = "2026-10-24T01:00:00";

    expect(() => PublicSeedFixtureSchema.parse(localTimestamp)).toThrow();
  });

  it("validates every realtime event variant", () => {
    const driveway = PUBLIC_SEED_FIXTURE.driveway;
    const occurredAt = "2026-10-24T01:00:02Z";
    const events = [
      { type: "space.opened", entity_id: "space_demo_1", entity_version: 2, occurred_at: occurredAt, payload: { space: PUBLIC_SEED_FIXTURE.nearby.spaces[0] } },
      { type: "space.refreshed", entity_id: "space_demo_1", entity_version: 3, occurred_at: occurredAt, payload: { space: PUBLIC_SEED_FIXTURE.nearby.spaces[0] } },
      { type: "space.occupied", entity_id: "space_demo_1", entity_version: 4, occurred_at: occurredAt, payload: { space_id: "space_demo_1" } },
      { type: "space.expired", entity_id: "space_demo_1", entity_version: 5, occurred_at: occurredAt, payload: { space_id: "space_demo_1" } },
      { type: "sign_rule.updated", entity_id: "zone_demo_1", entity_version: 2, occurred_at: occurredAt, payload: { zone_id: "zone_demo_1", sign_rule: PUBLIC_SEED_FIXTURE.sign_rule } },
      { type: "driveway.updated", entity_id: driveway.id, entity_version: 2, occurred_at: occurredAt, payload: { driveway } },
      { type: "driveway.held", entity_id: driveway.id, entity_version: 3, occurred_at: occurredAt, payload: { driveway: { ...driveway, state: "HELD", held_by_user_id: "driver_demo", active_booking: { id: "booking_demo_1", state: "PROCESSING", payment_status: "PROCESSING" }, version: 3 } } },
      { type: "driveway.released", entity_id: driveway.id, entity_version: 4, occurred_at: occurredAt, payload: { driveway } },
      { type: "booking.confirmed", entity_id: "booking_demo_1", entity_version: 3, occurred_at: occurredAt, payload: { booking: PUBLIC_SEED_FIXTURE.booking, driveway: { ...driveway, state: "BOOKED", active_booking: { id: "booking_demo_1", state: "CONFIRMED", payment_status: "SETTLED" }, version: 3 } } },
      { type: "payment.failed", entity_id: "booking_demo_1", entity_version: 2, occurred_at: occurredAt, payload: { booking_id: "booking_demo_1", code: "SETTLEMENT_FAILED", retryable: true } },
    ];

    expect(events.map((event) => RealtimeEventSchema.parse(event))).toHaveLength(10);
  });

  it("caps agent search results at three options", () => {
    const option = PUBLIC_SEED_FIXTURE.agent_option;
    expect(() => AgentParkingSearchResponseSchema.parse({ generated_at: "2026-10-24T01:00:00Z", options: [option, option, option, option] })).toThrow();
  });

  it("requires the fixed half-mile radius for mobile nearby queries", () => {
    expect(
      NearbyParkingQuerySchema.parse({ lat: 37.775, lng: -122.419, radius_m: 804.672 }),
    ).toEqual({ lat: 37.775, lng: -122.419, radius_m: 804.672 });
    expect(() =>
      NearbyParkingQuerySchema.parse({ lat: 37.775, lng: -122.419, radius_m: 500 }),
    ).toThrow();
  });

  it("accepts only secure WebSocket negotiation URLs", () => {
    expect(
      RealtimeNegotiateResponseSchema.parse({
        url: "wss://curb.webpubsub.azure.com/client/hubs/curb?access_token=demo",
      }),
    ).toEqual({
      url: "wss://curb.webpubsub.azure.com/client/hubs/curb?access_token=demo",
    });
    expect(() =>
      RealtimeNegotiateResponseSchema.parse({ url: "https://example.test/negotiate" }),
    ).toThrow();
  });

  it("orders driveway availability by instant rather than timestamp spelling", () => {
    const base = {
      expected_version: 1,
      available: true,
      price_usdc: "8.00",
    };

    expect(
      DrivewayUpdateRequestSchema.parse({
        ...base,
        availability_start: "2026-10-24T01:00:00Z",
        availability_end: "2026-10-24T01:00:00.001Z",
      }),
    ).toBeDefined();
    expect(() =>
      DrivewayUpdateRequestSchema.parse({
        ...base,
        availability_start: "2026-10-24T01:00:00+00:00",
        availability_end: "2026-10-24T01:00:00Z",
      }),
    ).toThrow();
    expect(() =>
      DrivewayUpdateRequestSchema.parse({
        ...base,
        availability_start: "2026-10-24T01:00:01Z",
        availability_end: "2026-10-24T01:00:00Z",
      }),
    ).toThrow();
  });

  it("exposes the active booking and payment state on held driveways", () => {
    const held = {
      ...PUBLIC_SEED_FIXTURE.driveway,
      state: "HELD",
      held_by_user_id: "driver_demo",
      active_booking: {
        id: "booking_demo_1",
        state: "PROCESSING",
        payment_status: "PROCESSING",
      },
    };

    expect(PublicSeedFixtureSchema.shape.driveway.parse(held).active_booking).toEqual(
      held.active_booking,
    );
  });

  it("rejects coercion and unknown fields at contract boundaries", () => {
    expect(() =>
      NearbyParkingQuerySchema.parse({ lat: "37.775", lng: -122.419, radius_m: 804.672 }),
    ).toThrow();
    expect(() =>
      DemoSessionResponseSchema.parse({
        user: PUBLIC_SEED_FIXTURE.driver,
        token: "driver-demo-token",
        unexpected: true,
      }),
    ).toThrow();
  });

  it("versions payment-failure callbacks so stale attempts cannot win", () => {
    expect(
      PaymentFailedRequestSchema.parse({
        expected_booking_version: 2,
        code: "FACILITATOR_UNAVAILABLE",
        retryable: true,
      }),
    ).toEqual({
      expected_booking_version: 2,
      code: "FACILITATOR_UNAVAILABLE",
      retryable: true,
    });
    expect(() =>
      PaymentFailedRequestSchema.parse({
        code: "FACILITATOR_UNAVAILABLE",
        retryable: true,
      }),
    ).toThrow();
  });
});
