// Azure Web PubSub client. Gets a fresh client URL from the backend on every
// (re)connect, validates each message's envelope, and never clears app state on
// disconnect; the caller keeps showing the last honest state.

import { agentPositionPayload, type RealtimeEvent, type RealtimeEventType } from "@/api/types";

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
  "agent.position",
]);

export function parseRealtimeEvent(raw: unknown): RealtimeEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type as RealtimeEventType)) return null;
  if (typeof e.entity_id !== "string" || typeof e.entity_version !== "number") return null;
  if (typeof e.occurred_at !== "string" || !e.payload || typeof e.payload !== "object") return null;
  const event = e as unknown as RealtimeEvent;
  if (event.type === "agent.position" && !agentPositionPayload(event)) return null;
  return event;
}

const MAX_BACKOFF_MS = 10_000;
const POLL_INTERVAL_MS = 2_000;
const POLL_FALLBACK_AFTER = 3; // switch to polling after this many consecutive WS failures

export function connectWebPubSub(
  negotiate: () => Promise<string>,
  onEvent: (e: RealtimeEvent) => void,
  onStatus?: (s: RealtimeStatus) => void,
  pollUrl?: string,
): RealtimeConnection {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastSeq = 0;
  let polling = false;
  const delivered = new Set<string>();
  function deliver(event: RealtimeEvent) {
    const key = `${event.type}:${event.entity_id}:${event.entity_version}`;
    if (delivered.has(key)) return;
    delivered.add(key);
    if (delivered.size > 2000) delivered.delete(delivered.values().next().value!);
    onEvent(event);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (pollTimer || closed || !pollUrl) return;
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const res = await fetch(`${pollUrl}?since=${lastSeq}`);
        if (!res.ok || closed) return;
        const data = await res.json();
        if (closed) return;
        onStatus?.("open");
        const events: unknown[] = data?.events ?? [];
        for (const raw of events) {
          const seq = (raw as Record<string, unknown>)?.seq;
          if (typeof seq === "number" && seq > lastSeq) lastSeq = seq;
          const event = parseRealtimeEvent(raw);
          if (event) deliver(event);
        }
      } catch {
        // Keep the last good map through temporary network failures.
      } finally { polling = false; }
    };
    pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    void poll();
  }

  async function open() {
    if (closed) return;
    onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    try {
      const url = await negotiate();
      if (closed) return;
      if (!url) throw new Error("negotiate returned null url");
      ws = new WebSocket(url, "json.webpubsub.azure.v1");
      ws.onopen = () => {
        attempt = 0;
        // Keep the polling safety net: an open socket does not prove pushes arrive.
        onStatus?.("open");
      };
      ws.onmessage = (msg) => {
        try {
          const frame = JSON.parse(String(msg.data));
          // Server messages arrive as { type: "message", data: <event> }.
          const event = parseRealtimeEvent(frame?.type === "message" ? frame.data : frame);
          if (event) deliver(event);
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
    if (attempt >= POLL_FALLBACK_AFTER) {
      // WS has failed multiple times — fall back to polling
      startPolling();
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt);
    retry = setTimeout(open, delay);
    onStatus?.("reconnecting");
  }

  open();
  startPolling();

  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      stopPolling();
      ws?.close();
      onStatus?.("closed");
    },
  };
}
