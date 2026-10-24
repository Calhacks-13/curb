// Azure Web PubSub client. Gets a fresh client URL from the backend on every
// (re)connect, validates each message's envelope, and never clears app state on
// disconnect; the caller keeps showing the last honest state.

import type { RealtimeEvent, RealtimeEventType } from "@/api/types";

import type { RealtimeConnection, RealtimeStatus } from "@/api/client";

const EVENT_TYPES: ReadonlySet<RealtimeEventType> = new Set<RealtimeEventType>([
  "space.opened",
  "space.refreshed",
  "space.occupied",
  "space.expired",
  "sign_rule.updated",
  "driveway.updated",
  "driveway.held",
  "driveway.released",
  "booking.confirmed",
  "payment.failed",
]);

export function parseRealtimeEvent(raw: unknown): RealtimeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type as RealtimeEventType)) return null;
  if (typeof e.entity_id !== "string" || typeof e.entity_version !== "number") return null;
  if (typeof e.occurred_at !== "string" || !e.payload || typeof e.payload !== "object") return null;
  return e as unknown as RealtimeEvent;
}

const MAX_BACKOFF_MS = 10_000;

export function connectWebPubSub(
  negotiate: () => Promise<string>,
  onEvent: (e: RealtimeEvent) => void,
  onStatus?: (s: RealtimeStatus) => void,
): RealtimeConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  async function open() {
    if (closed) return;
    onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const url = await negotiate();
      if (closed) return;
      ws = new WebSocket(url, "json.webpubsub.azure.v1");
      ws.onopen = () => {
        attempt = 0;
        onStatus?.("open");
      };
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(String(msg.data));
          // Server messages arrive as { type: "message", data: <event> }.
          const event = parseRealtimeEvent(frame?.type === "message" ? frame.data : frame);
          if (event) onEvent(event);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = schedule;
      ws.onerror = () => ws?.close();
    } catch {
      schedule();
    }
  }

  function schedule() {
    if (closed) return;
    attempt++;
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    retry = setTimeout(open, delay);
    onStatus?.("reconnecting");
  }

  open();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
      onStatus?.("closed");
    },
  };
}
