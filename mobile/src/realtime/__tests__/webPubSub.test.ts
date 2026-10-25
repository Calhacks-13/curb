import { connectWebPubSub, parseRealtimeEvent } from "@/realtime/webPubSub";

class FakeSocket {
  static all: FakeSocket[] = [];
  onopen?: () => void;
  onmessage?: (m: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(
    readonly url: string,
    readonly protocol: string,
  ) {
    FakeSocket.all.push(this);
  }
  close() {
    this.onclose?.();
  }
}

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

describe("Web PubSub client", () => {
  const RealWS = globalThis.WebSocket;
  beforeEach(() => {
    FakeSocket.all = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  });
  afterEach(() => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = RealWS;
    jest.useRealTimers();
  });

  it("validates the envelope and delivers server messages", async () => {
    const onEvent = jest.fn();
    const conn = connectWebPubSub(async () => "wss://x/1", onEvent);
    await flush();
    const ws = FakeSocket.all[0];
    expect(ws.protocol).toBe("json.webpubsub.azure.v1");
    const event = { type: "space.opened", entity_id: "s1", entity_version: 2, occurred_at: "2026-10-24T18:00:00Z", payload: {} };
    ws.onmessage?.({ data: JSON.stringify({ type: "message", data: event }) });
    ws.onmessage?.({ data: JSON.stringify({ type: "message", data: { type: "space.opened", entity_id: "s1" } }) });
    ws.onmessage?.({ data: "not json" });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
    conn.close();
  });

  it("negotiates a fresh URL on every reconnect", async () => {
    jest.useFakeTimers();
    let n = 0;
    const negotiate = jest.fn(async () => `wss://x/${++n}`);
    const statuses: string[] = [];
    const conn = connectWebPubSub(negotiate, () => {}, (s) => statuses.push(s));
    await Promise.resolve();
    await Promise.resolve();
    FakeSocket.all[0].onclose?.(); // network drop
    await jest.advanceTimersByTimeAsync(1500);
    expect(negotiate).toHaveBeenCalledTimes(2);
    expect(FakeSocket.all.map((s) => s.url)).toEqual(["wss://x/1", "wss://x/2"]);
    expect(statuses).toContain("reconnecting");
    conn.close();
  });

  it("rejects unknown event types", () => {
    expect(parseRealtimeEvent({ type: "space.teleported", entity_id: "s", entity_version: 1, occurred_at: "", payload: {} })).toBeNull();
  });

  it("accepts only finite longitude-latitude agent positions and headings", () => {
    const event = {
      type: "agent.position",
      entity_id: "av_demo",
      entity_version: 4,
      occurred_at: "2026-10-25T01:00:00Z",
      payload: { position: [-122.41825, 37.77539], heading: 67 },
    };

    expect(parseRealtimeEvent(event)).toEqual(event);
    expect(parseRealtimeEvent({ ...event, payload: { position: [37.7], heading: 67 } })).toBeNull();
    expect(parseRealtimeEvent({ ...event, payload: { position: [-122.4, 91], heading: 67 } })).toBeNull();
    expect(parseRealtimeEvent({ ...event, payload: { position: [-122.4, 37.7], heading: Number.NaN } })).toBeNull();
  });
});
