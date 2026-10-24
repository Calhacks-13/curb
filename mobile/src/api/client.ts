// Typed client for the Curb backend (spec section 12 / plan "Locked External
// Contracts"). getApi() returns the live HTTP client when EXPO_PUBLIC_API_URL is
// set, otherwise the in-memory demo replay adapter.

import * as FileSystem from "expo-file-system/legacy";

import { createDemoApi } from "@/demo/demoApi";
import { ApiError } from "./errors";
import { connectWebPubSub } from "@/realtime/webPubSub";

import {
  FIND_RADIUS_M,
  type Booking,
  type DemoProfile,
  type Driveway,
  type DrivewayUpdate,
  type FrameAccepted,
  type FrameMetadata,
  type NearbyParkingResponse,
  type RealtimeEvent,
  type Session,
  type SpaceDetail,
} from "./types";

export { ApiError };

export type RealtimeStatus = "connecting" | "open" | "reconnecting" | "closed";

export type RealtimeConnection = { close(): void };

export interface CurbApi {
  /** "demo" data must always be shown with the Demo replay badge. */
  readonly mode: "live" | "demo";
  setToken(token: string | null): void;
  startSession(profile: DemoProfile): Promise<Session>;
  nearby(lat: number, lng: number, radiusM?: number): Promise<NearbyParkingResponse>;
  space(spaceId: string): Promise<SpaceDetail>;
  updateDriveway(drivewayId: string, update: DrivewayUpdate): Promise<Driveway>;
  holdDriveway(drivewayId: string, expectedVersion: number): Promise<Booking>;
  cancelHold(drivewayId: string, bookingId: string): Promise<Driveway>;
  recoverDriveway(drivewayId: string, expectedVersion: number): Promise<Driveway>;
  executePayment(bookingId: string): Promise<Booking>;
  booking(bookingId: string): Promise<Booking>;
  uploadFrame(jpegUri: string, meta: FrameMetadata): Promise<FrameAccepted>;
  connectRealtime(onEvent: (e: RealtimeEvent) => void, onStatus?: (s: RealtimeStatus) => void): RealtimeConnection;
}

function createHttpApi(baseUrl: string, paymentsUrl: string): CurbApi {
  let token: string | null = null;

  async function call<T>(method: string, path: string, body?: unknown, base = baseUrl): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  const api: CurbApi = {
    mode: "live",
    setToken(t) {
      token = t;
    },
    startSession: (profile) => call("POST", "/v1/demo/sessions", { profile }),
    nearby: (lat, lng, radiusM = FIND_RADIUS_M) =>
      call("GET", `/v1/parking/nearby?lat=${lat}&lng=${lng}&radius_m=${radiusM}`),
    space: (id) => call("GET", `/v1/spaces/${encodeURIComponent(id)}`),
    updateDriveway: (id, update) => call("PATCH", `/v1/driveways/${encodeURIComponent(id)}`, update),
    holdDriveway: (id, expected_version) => call("POST", `/v1/driveways/${encodeURIComponent(id)}/holds`, { expected_version }),
    cancelHold: (id, bookingId) =>
      call("DELETE", `/v1/driveways/${encodeURIComponent(id)}/holds/${encodeURIComponent(bookingId)}`),
    recoverDriveway: (id, expected_version) =>
      call("POST", `/v1/driveways/${encodeURIComponent(id)}/recover`, { expected_version }),
    async executePayment(bookingId) {
      // The payment service answers { booking, explorer_url }; accept a bare booking too.
      const res = await call<Booking | { booking: Booking }>(
        "POST",
        `/v1/payments/${encodeURIComponent(bookingId)}/execute`,
        undefined,
        paymentsUrl,
      );
      return "booking" in res ? res.booking : res;
    },
    booking: (id) => call("GET", `/v1/bookings/${encodeURIComponent(id)}`),
    async uploadFrame(jpegUri, meta) {
      // Use native FileSystem upload — React Native's fetch+FormData is unreliable for file uploads.
      const result = await FileSystem.uploadAsync(
        `${baseUrl}/v1/vision/frames`,
        jpegUri,
        {
          httpMethod: "POST",
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: "frame",
          mimeType: "image/jpeg",
          parameters: { metadata: JSON.stringify(meta) },
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
      );
      if (result.status < 200 || result.status >= 300) {
        throw new ApiError(result.status, `POST /v1/vision/frames failed (${result.status})`);
      }
      return JSON.parse(result.body) as FrameAccepted;
    },
    connectRealtime(onEvent, onStatus) {
      return connectWebPubSub(
        async () => (await call<{ url: string }>("POST", "/v1/realtime/negotiate")).url,
        onEvent,
        onStatus,
        `${baseUrl}/v1/realtime/events`,
      );
    },
  };
  return api;
}

let instance: CurbApi | null = null;

export function getApi(): CurbApi {
  if (instance) return instance;
  const base = process.env.EXPO_PUBLIC_API_URL;
  instance = base ? createHttpApi(base, process.env.EXPO_PUBLIC_PAYMENTS_URL ?? base) : createDemoApi();
  return instance;
}
