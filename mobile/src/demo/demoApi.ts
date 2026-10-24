// In-memory "Demo replay" implementation of CurbApi. Used when no backend URL
// is configured. It follows the same contracts and state machine as the real
// service (version checks, AVAILABLE -> HELD -> BOOKED), but it is a fixture:
// the UI must show the Demo replay badge, and payments here move no money.

import type { CurbApi, RealtimeConnection } from "@/api/client";
import { ApiError } from "@/api/errors";
import { distanceM } from "@/data/geo";
import {
  DEMO_IDS,
  FIND_RADIUS_M,
  type LngLat,
  type Booking,
  type Driveway,
  type NearbyParkingResponse,
  type ParkingSpace,
  type PaymentPhase,
  type RealtimeEvent,
  type RealtimeEventType,
  type Session,
  type SignRuleView,
  type User,
  type WalletInfo,
} from "@/api/types";

import { buildDemoFixture, REPLAY_TARGETS, spaceIdFor } from "./fixtures";

const PAYMENT_MS = 2600;

/** Replay script, seconds after the first realtime connection. */
const SCRIPT: { at: number; run: (api: DemoState) => void }[] = [
  { at: 12, run: (s) => s.openSpace(...REPLAY_TARGETS.newOpening) },
  { at: 30, run: (s) => s.refreshSpace("zone_demo_1", 3) },
  { at: 55, run: (s) => s.occupySpace(...REPLAY_TARGETS.occupiedLater) },
];
const KEEPALIVE_S = 40;

type DemoState = ReturnType<typeof createState>;

function createState(emit: (e: RealtimeEvent) => void) {
  const now = new Date();
  const fixture = buildDemoFixture(now);
  const spaces = new Map(fixture.spaces.map((s) => [s.id, s]));
  const zones = new Map(fixture.zones.map((z) => [z.id, z]));
  const driveways = new Map(fixture.driveways.map((d) => [d.id, d]));
  const bookings = new Map<string, Booking>();
  const rules: Record<string, SignRuleView> = fixture.rules;

  const send = (type: RealtimeEventType, id: string, version: number, payload: object) =>
    emit({ type, entity_id: id, entity_version: version, occurred_at: new Date().toISOString(), payload: { ...payload } });

  function updateSpace(zoneId: string, index: number, patch: Partial<ParkingSpace>, type: RealtimeEventType) {
    const id = spaceIdFor(fixture.spaces, zoneId, index);
    const prev = id ? spaces.get(id) : undefined;
    if (!prev) return;
    const next = { ...prev, ...patch, version: prev.version + 1 };
    spaces.set(next.id, next);
    send(type, next.id, next.version, next);
  }

  function putDriveway(d: Driveway, type: RealtimeEventType) {
    driveways.set(d.id, d);
    send(type, d.id, d.version, d);
  }

  function putBooking(b: Booking, type?: RealtimeEventType) {
    bookings.set(b.id, b);
    if (type) send(type, b.id, b.version, b);
  }

  return {
    spaces,
    zones,
    driveways,
    bookings,
    rules,
    openSpace: (z: string, i: number) =>
      updateSpace(z, i, { internal_state: "OPEN", last_observed_at: new Date().toISOString(), base_confidence: 0.86 }, "space.opened"),
    refreshSpace: (z: string, i: number) =>
      updateSpace(z, i, { internal_state: "OPEN", last_observed_at: new Date().toISOString() }, "space.refreshed"),
    occupySpace: (z: string, i: number) =>
      updateSpace(z, i, { internal_state: "OCCUPIED", last_observed_at: new Date().toISOString() }, "space.occupied"),
    putDriveway,
    putBooking,
  };
}

export function createDemoApi(): CurbApi {
  const listeners = new Set<(e: RealtimeEvent) => void>();
  const state = createState((e) => listeners.forEach((fn) => fn(e)));
  let timers: ReturnType<typeof setTimeout>[] = [];
  let user: User = { id: DEMO_IDS.driver, display_name: "Demo driver", demo_profile: "driver" };
  // Demo replay wallet: a balance on screen only; nothing is on-chain.
  let demoBalance = 25;
  const paymentStarted = new Map<string, number>();

  function startScript() {
    if (timers.length) return;
    timers = SCRIPT.map((step) => setTimeout(() => step.run(state), step.at * 1000));
    timers.push(
      setInterval(() => {
        state.refreshSpace("zone_demo_1", 3);
        state.refreshSpace(...REPLAY_TARGETS.newOpening);
      }, KEEPALIVE_S * 1000) as unknown as ReturnType<typeof setTimeout>,
    );
  }

  function driveway(id: string): Driveway {
    const d = state.driveways.get(id);
    if (!d) throw new ApiError(404, "Driveway not found");
    return d;
  }

  function checkVersion(d: { version: number }, expected: number) {
    if (d.version !== expected) throw new ApiError(409, "Version conflict");
  }

  return {
    mode: "demo",
    setToken() {},

    async startSession(profile): Promise<Session> {
      user =
        profile === "owner"
          ? { id: DEMO_IDS.owner, display_name: "Demo driveway owner", demo_profile: "owner" }
          : { id: DEMO_IDS.driver, display_name: "Demo driver", demo_profile: "driver" };
      return { user, token: `demo-${profile}` };
    },

    async nearby(lat, lng, radiusM = FIND_RADIUS_M): Promise<NearbyParkingResponse> {
      // Same radius filter as the backend's nearby query.
      const near = (p: LngLat) => distanceM([lng, lat], p) <= radiusM;
      return {
        generated_at: new Date().toISOString(),
        zones: [...state.zones.values()].filter((z) => z.geometry.coordinates.some(near)),
        spaces: [...state.spaces.values()].filter((sp) => near(sp.location.coordinates)),
        driveways: [...state.driveways.values()].filter((d) => near(d.location.coordinates)),
      };
    },

    async space(id) {
      const space = state.spaces.get(id);
      if (!space) throw new ApiError(404, "Space not found");
      const zone = state.zones.get(space.zone_id)!;
      return { space, zone, rule: zone.sign_rule_id ? state.rules[zone.sign_rule_id] ?? null : null };
    },

    async updateDriveway(id, update) {
      const d = driveway(id);
      checkVersion(d, update.expected_version);
      const busy = d.state === "HELD" || d.state === "BOOKED";
      const next: Driveway = {
        ...d,
        price_usdc: update.price_usdc,
        availability_start: update.availability_start,
        availability_end: update.availability_end,
        state: busy ? d.state : update.available ? "AVAILABLE" : "UNAVAILABLE",
        version: d.version + 1,
      };
      state.putDriveway(next, "driveway.updated");
      return next;
    },

    async holdDriveway(id, expectedVersion) {
      const d = driveway(id);
      checkVersion(d, expectedVersion);
      if (d.state !== "AVAILABLE") throw new ApiError(409, "Driveway is not available");
      const now = new Date().toISOString();
      const booking: Booking = {
        id: `booking_demo_${Date.now()}`,
        idempotency_key: `idem_${Date.now()}`,
        driveway_id: id,
        driver_id: user.id,
        state: "PENDING_PAYMENT",
        amount_usdc: d.price_usdc,
        network: "base-sepolia",
        transaction_hash: null,
        created_at: now,
        confirmed_at: null,
        version: 1,
      };
      state.putBooking(booking);
      state.putDriveway({ ...d, state: "HELD", held_by_user_id: user.id, version: d.version + 1 }, "driveway.held");
      return booking;
    },

    async cancelHold(id, bookingId) {
      const d = driveway(id);
      const b = state.bookings.get(bookingId);
      if (b?.state === "PROCESSING") throw new ApiError(409, "Payment is processing");
      if (b) state.putBooking({ ...b, state: "CANCELLED", version: b.version + 1 });
      const next: Driveway = { ...d, state: "AVAILABLE", held_by_user_id: null, version: d.version + 1 };
      state.putDriveway(next, "driveway.released");
      return next;
    },

    async recoverDriveway(id, expectedVersion) {
      const d = driveway(id);
      checkVersion(d, expectedVersion);
      const processing = [...state.bookings.values()].some((b) => b.driveway_id === id && b.state === "PROCESSING");
      if (processing || d.state !== "HELD") throw new ApiError(409, "Cannot recover while payment is processing");
      const next: Driveway = { ...d, state: "AVAILABLE", held_by_user_id: null, version: d.version + 1 };
      state.putDriveway(next, "driveway.released");
      return next;
    },

    async executePayment(bookingId) {
      const b = state.bookings.get(bookingId);
      if (!b) throw new ApiError(404, "Booking not found");
      // Idempotent: a repeat call returns the same booking, never a second payment.
      if (b.state === "CONFIRMED" || b.state === "PROCESSING") return b;
      const processing: Booking = { ...b, state: "PROCESSING", version: b.version + 1 };
      state.putBooking(processing);
      paymentStarted.set(bookingId, Date.now());
      await new Promise((r) => setTimeout(r, PAYMENT_MS));
      // Demo replay: no chain transaction exists, so there is no hash to show.
      const confirmed: Booking = { ...processing, state: "CONFIRMED", confirmed_at: new Date().toISOString(), version: processing.version + 1 };
      state.putBooking(confirmed, "booking.confirmed");
      demoBalance = Math.max(0, demoBalance - Number(b.amount_usdc));
      const d = driveway(b.driveway_id);
      state.putDriveway({ ...d, state: "BOOKED", version: d.version + 1 }, "driveway.updated");
      return confirmed;
    },

    async paymentProgress(bookingId) {
      const b = state.bookings.get(bookingId);
      const started = paymentStarted.get(bookingId);
      if (!b || started === undefined) return { booking_id: bookingId, phase: null };
      if (b.state === "CONFIRMED") return { booking_id: bookingId, phase: "confirmed" };
      // Walk the same steps as the live service across the simulated settlement.
      const t = (Date.now() - started) / PAYMENT_MS;
      const phase: PaymentPhase = t < 0.25 ? "approved" : t < 0.6 ? "signed" : "settled";
      return { booking_id: bookingId, phase };
    },

    async wallet(): Promise<WalletInfo> {
      return {
        network: "base-sepolia",
        payer: { name: "Demo wallet", address: "0xDe0000000000000000000000000000000000Demo", usdc_balance: String(demoBalance), explorer_url: "" },
        payee: { name: "Driveway owner", address: "0x0000000000000000000000000000000000Owner" },
      };
    },

    async topUpWallet() {
      demoBalance += 10;
      return { transaction_hash: "", explorer_url: "" };
    },

    async booking(id) {
      const b = state.bookings.get(id);
      if (!b) throw new ApiError(404, "Booking not found");
      return b;
    },

    async uploadDetections() {
      // Demo replay doesn't run vision; detections are dropped immediately.
      return { frame_id: `frame_demo_${Date.now()}`, accepted: false };
    },

    connectRealtime(onEvent, onStatus): RealtimeConnection {
      listeners.add(onEvent);
      onStatus?.("open");
      startScript();
      return {
        close() {
          listeners.delete(onEvent);
          onStatus?.("closed");
          if (!listeners.size) {
            timers.forEach((t) => clearTimeout(t));
            timers = [];
          }
        },
      };
    },
  };
}
