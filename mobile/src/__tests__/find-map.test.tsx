import { act, fireEvent, render, screen } from "@testing-library/react-native";

import FindScreen from "@/app/(tabs)/find";
import type { NearbyParkingResponse, RealtimeEvent, SpaceDetail } from "@/api/types";
import type { AppToMap } from "@/map/messages";
import type { CameraOverlay } from "@/components/CameraOverlay";

// Only native/external surfaces are doubled: Find, CurbMap, the HTTP client,
// nearby reducer, freshness clock and detail sheet all run together.
const mockMessages: AppToMap[] = [];
jest.mock("react-native-webview", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return { WebView: React.forwardRef(function MockWebView(props: object, ref: React.ForwardedRef<unknown>) {
    React.useImperativeHandle(ref, () => ({ injectJavaScript: (script: string) => {
      const payload = script.slice(script.indexOf("receive(") + 8, script.lastIndexOf(");true;"));
      mockMessages.push(JSON.parse(payload));
    } }));
    return <View {...props} testID="map-webview" />;
  }) };
});
let mockCameraProps: React.ComponentProps<typeof CameraOverlay>;
let mockPipExpanded = false;
jest.mock("@/components/CameraOverlay", () => ({ CameraOverlay: (props: React.ComponentProps<typeof CameraOverlay>) => { mockCameraProps = props; return null; } }));
jest.mock("@/components/DraggablePip", () => ({ DraggablePip: ({ children, expanded }: { children: React.ReactNode; expanded: boolean }) => {
  mockPipExpanded = expanded;
  return children;
} }));
jest.mock("@/components/sheet/SheetFrame", () => ({ SHEET_PEEK: 78, SheetFrame: ({ children }: { children: React.ReactNode }) => children }));
jest.mock("@/features/capture/detectionUpload", () => ({ getDeviceId: async () => "phone", newCaptureSessionId: () => "capture" }));
jest.mock("@/hooks/useScreenFocused", () => ({ useScreenFocused: () => true }));
jest.mock("@/hooks/useReduceMotion", () => ({ useReduceMotion: () => true }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock("@/features/session/SessionContext", () => ({ useSession: () => ({ session: { user: { id: "driver", demo_profile: "driver", display_name: "Driver" } } }) }));
let mockPosition: [number, number] | null = [-122.43597, 37.79932];
let mockLocationStatus = "granted";
jest.mock("@/features/capture/useDriverLocation", () => ({ useDriverLocation: () => ({ position: mockPosition, status: mockLocationStatus, heading: 0, accuracyM: 3, canAskAgain: true, request: async () => {} }) }));
let mockOnEvent: (event: RealtimeEvent) => void;
jest.mock("@/realtime/webPubSub", () => ({ connectWebPubSub: (_: unknown, onEvent: typeof mockOnEvent) => {
  mockOnEvent = onEvent;
  return { close() {} };
} }));

const NOW = Date.parse("2026-10-24T21:00:00.000Z");
const CENTER: [number, number] = [-122.43597, 37.79932];
const ring: [number, number][] = [CENTER, [-122.43594, 37.79932], [-122.43594, 37.79935], CENTER];
const nearby: NearbyParkingResponse = {
  generated_at: new Date(NOW).toISOString(),
  zones: [{ id: "legal", geometry: { type: "LineString", coordinates: [CENTER, [-122.43597, 37.7998]] }, sign_rule_id: "rule", legal_status_now: "LEGAL", next_change_at: null, version: 1 }],
  spaces: [
    { id: "fresh", age: 89.65, internal_state: "OPEN" },
    { id: "aging", age: 120, internal_state: "OPEN" },
    { id: "stale", age: 220, internal_state: "OPEN" },
    { id: "occupied", age: 10, internal_state: "OCCUPIED" },
  ].map(({ id, age, internal_state }) => ({ id, zone_id: "legal", location: { type: "Point", coordinates: CENTER }, stall_geometry: { type: "Polygon", coordinates: [ring] }, internal_state: internal_state as "OPEN" | "OCCUPIED", last_observed_at: new Date(NOW - age * 1000).toISOString(), base_confidence: 0.93, detection_confidence: 0.9, version: 1 })),
  driveways: [{ id: "driveway", owner_id: "owner", location: { type: "Point", coordinates: CENTER }, photo_url: null, price_usdc: "8.00", availability_start: "08:00", availability_end: "22:00", availability_timezone: "America/Los_Angeles", state: "AVAILABLE", held_by_user_id: null, version: 1 }],
};
const detail: SpaceDetail = {
  space: nearby.spaces[0], zone: nearby.zones[0],
  rule: { id: "rule", summary: "Two-hour parking allowed now.", max_minutes: 120, next_change_at: "2026-10-25T01:00:00Z", next_change_summary: "No time limit", payment_text: null, permit_text: null, interpretation_confidence: 0.97, last_validated_at: "2026-10-24T18:00:00Z" },
};
const mockFetch = jest.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/spaces/") ? detail : url.includes("directions/") ? { routes: [{ geometry: { coordinates: [CENTER, CENTER] }, duration: 60, distance: 100 }] } : nearby }));

function latest<T extends AppToMap["type"]>(type: T): Extract<AppToMap, { type: T }> {
  return mockMessages.filter((m) => m.type === type).at(-1) as Extract<AppToMap, { type: T }>;
}
async function mount() {
  const result = await render(<FindScreen />);
  await fireEvent(screen.getByTestId("map-webview"), "message", { nativeEvent: { data: JSON.stringify({ type: "mapReady" }) } });
  await act(async () => {});
  return result;
}

describe("Find map from the live typed client", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    process.env.EXPO_PUBLIC_API_URL = "https://curb.test";
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockClear();
    mockMessages.length = 0;
    mockPosition = CENTER;
    mockLocationStatus = "granted";
    mockPipExpanded = false;
  });
  afterEach(() => { jest.useRealTimers(); });

  it("sends labeled fresh/aging/stale/driveway shapes to the map without curb lines, using precise GPS", async () => {
    await mount();
    expect(mockFetch).toHaveBeenCalledWith("https://curb.test/v1/parking/nearby?lat=37.79932&lng=-122.43597&radius_m=804.672", expect.anything());
    expect(mockMessages.some((m) => (m.type as string) === "setZones")).toBe(false);
    expect(latest("setStalls").stalls.map(({ id, kind }) => ({ id, kind }))).toEqual([
      { id: "fresh", kind: "fresh" }, { id: "driveway", kind: "driveway" }, { id: "aging", kind: "aging" }, { id: "stale", kind: "stale" },
    ]);
    expect(latest("setStalls").stalls[0].ring).toEqual(ring);
    expect(latest("setPills").pills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fresh", label: "65% open" }),
      expect.objectContaining({ id: "aging", label: "56% open" }),
      expect.objectContaining({ id: "stale", label: "25% open" }),
      expect.objectContaining({ id: "driveway", label: expect.stringContaining("Reserve") }),
    ]));
    expect(latest("setPills").pills.some((p) => p.id === "occupied")).toBe(false);
  });

  it("opens rules and confidence after a pin tap and requests a route only on Route here", async () => {
    await mount();
    await fireEvent(screen.getByTestId("map-webview"), "message", { nativeEvent: { data: JSON.stringify({ type: "spotTapped", id: "fresh" }) } });
    expect(await screen.findByText("Two-hour parking allowed now.")).toBeTruthy();
    expect(screen.getByLabelText("Chance the spot is open: 65 percent")).toBeTruthy();
    expect(latest("setPills").pills.find((p) => p.id === "fresh")?.label).toBe("65% open");
    expect(screen.getByLabelText("Detection confidence: 90%")).toBeTruthy();
    expect(screen.getByLabelText("Parking rule confidence: 97%")).toBeTruthy();
    expect(screen.queryByText("Likely open")).toBeNull();
    expect(screen.getByText("2 hr")).toBeTruthy();
    expect(mockFetch.mock.calls.some(([url]) => url.includes("directions/"))).toBe(false);
    expect(latest("setRoute")).toBeUndefined();
    await fireEvent.press(screen.getByText("Route here"));
    await act(async () => {});
    expect(mockFetch.mock.calls.some(([url]) => url.includes("directions/"))).toBe(true);
    expect(latest("setRoute").targetId).toBe("fresh");
  });

  it("keeps inclusive 90/180/300-second bounds and updates one millisecond after each without server events", async () => {
    await mount();
    for (const [advance, kind] of [[350, "fresh"], [1, "aging"], [89_999, "aging"], [1, "stale"], [119_999, "stale"], [1, null]] as const) {
      await act(async () => { jest.advanceTimersByTime(advance); });
      expect(latest("setPills").pills.find((p) => p.id === "fresh")?.kind ?? null).toBe(kind);
    }
    expect(mockFetch.mock.calls.filter(([url]) => url.includes("/nearby"))).toHaveLength(1);
  });

  it("updates map geometry and the driveway price when fresh data keeps the same IDs and kinds", async () => {
    await mount();
    const oldRing = latest("setStalls").stalls.find((p) => p.id === "driveway")?.ring;
    const moved: [number, number] = [-122.4359, 37.7994];
    await act(async () => mockOnEvent({ type: "driveway.updated", entity_id: "driveway", entity_version: 2, occurred_at: new Date(NOW).toISOString(), payload: { ...nearby.driveways[0], location: { type: "Point", coordinates: moved }, price_usdc: "12.00", version: 2 } }));
    expect(latest("setPills").pills.find((p) => p.id === "driveway")).toEqual(expect.objectContaining({ position: moved, label: expect.stringContaining("$12") }));
    expect(latest("setStalls").stalls.find((p) => p.id === "driveway")?.ring).not.toEqual(oldRing);
  });

  it("forwards valid AV positions independently from the phone car and ignores malformed payloads", async () => {
    await mount();
    const car = latest("setCarPosition");
    const before = mockMessages.length;

    await act(async () => mockOnEvent({
      type: "agent.position",
      entity_id: "av_demo",
      entity_version: 1,
      occurred_at: new Date(NOW).toISOString(),
      payload: { position: [-122.41825, 37.77539], heading: 67 },
    } as RealtimeEvent));

    expect(latest("setAgentPosition")).toEqual({
      type: "setAgentPosition",
      position: [-122.41825, 37.77539],
      heading: 67,
    });
    expect(latest("setCarPosition")).toEqual(car);

    await act(async () => mockOnEvent({
      type: "agent.position",
      entity_id: "av_demo",
      entity_version: 2,
      occurred_at: new Date(NOW).toISOString(),
      payload: { position: ["bad"], heading: 67 },
    } as unknown as RealtimeEvent));
    expect(mockMessages.slice(before).filter((message) => message.type === "setAgentPosition")).toHaveLength(1);
  });

  it("shows paired camera feedback when the fresh space and its zone share an ID and version", async () => {
    await mount();
    await act(async () => { mockCameraProps.onSpotConfirmed?.({
      frame_id: "confirmed-frame", accepted: true,
      space: { ...nearby.spaces[0], id: "scan-segment", zone_id: "scan-segment", last_observed_at: new Date(NOW).toISOString() },
      zone: { ...nearby.zones[0], id: "scan-segment" },
    }); });
    expect(latest("setStalls").stalls).toContainEqual(expect.objectContaining({ id: "scan-segment", kind: "fresh", ring }));
    expect(latest("setPills").pills).toContainEqual(expect.objectContaining({ id: "scan-segment", kind: "fresh", label: "93% open" }));
  });

  it.each(["pending", "denied"])("does not query or show demo supply while live location is %s", async (status) => {
    mockPosition = null;
    mockLocationStatus = status;
    await mount();
    expect(mockFetch.mock.calls.filter(([url]) => url.includes("/nearby"))).toHaveLength(0);
    expect(latest("setPills").pills).toEqual([]);
    expect(mockMessages.some((m) => m.type === "setCarPosition")).toBe(false);
    expect(mockCameraProps.sampling).toBe(false);
    expect(mockCameraProps.frameContext()).toBeNull();
    if (status === "denied") expect(screen.getByText("Location is off")).toBeTruthy();
  });

  it("never supplies demo GPS to live detections and starts inference only after a real fix", async () => {
    mockPosition = null;
    const view = await mount();
    expect(mockCameraProps.frameContext()).toBeNull();
    mockPosition = [-122.2, 37.6];
    await view.rerender(<FindScreen />);
    expect(mockCameraProps.sampling).toBe(true);
    expect(mockCameraProps.frameContext()).toEqual(expect.objectContaining({ lat: 37.6, lng: -122.2, device_id: "phone" }));
    mockPosition = null;
    await view.rerender(<FindScreen />);
    expect(mockCameraProps.sampling).toBe(false);
    expect(mockCameraProps.frameContext()).toBeNull();
  });

  async function routeToFresh() {
    await mount();
    await fireEvent(screen.getByTestId("map-webview"), "message", { nativeEvent: { data: JSON.stringify({ type: "spotTapped", id: "fresh" }) } });
    await screen.findByText("Two-hour parking allowed now.");
    await fireEvent.press(screen.getByText("Route here"));
    await act(async () => {});
    expect(latest("setRoute").targetId).toBe("fresh");
  }
  const tick = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
  const spaceEvent = (type: "space.opened" | "space.refreshed", id: string, version: number, base: number): RealtimeEvent => {
    const observed = new Date(Date.now()).toISOString();
    return { type, entity_id: id, entity_version: version, occurred_at: observed, payload: { ...nearby.spaces[0], id, last_observed_at: observed, base_confidence: base, version } };
  };

  it("keeps route confidence live, reports drops, and replaces below 50% only on confirmation", async () => {
    await routeToFresh();
    expect(screen.getByLabelText("Chance the spot is open: 65 percent")).toBeTruthy();
    expect(screen.getByText("Still showing open.")).toBeTruthy();
    expect(screen.queryByText(/Confidence fell/)).toBeNull();

    await tick(5_000);
    expect(screen.getByText("64% open")).toBeTruthy();
    expect(screen.getByText("Confidence fell 1% while routing")).toBeTruthy();

    await act(async () => mockOnEvent(spaceEvent("space.opened", "alt", 1, 0.9)));
    await tick(45_000);
    expect(screen.getByText("50% open")).toBeTruthy();
    expect(screen.queryByText(/under 50% likely/)).toBeNull();

    await tick(1_000);
    expect(screen.getByText("49% open")).toBeTruthy();
    expect(screen.getByText("That spot is now under 50% likely to be open")).toBeTruthy();
    expect(latest("setRoute").targetId).toBe("fresh");

    await fireEvent.press(screen.getByText("Route to new spot"));
    await act(async () => {});
    expect(latest("setRoute").targetId).toBe("alt");
  });

  it("raises the routed score on a refreshed observation without a false drop", async () => {
    await routeToFresh();
    await tick(10_000);
    expect(screen.getByText("Confidence fell 3% while routing")).toBeTruthy();

    await act(async () => mockOnEvent(spaceEvent("space.refreshed", "fresh", 2, 0.97)));

    expect(screen.getByText("97% open")).toBeTruthy();
    expect(screen.queryByText(/Confidence fell/)).toBeNull();
    expect(screen.queryByText(/Confidence is falling/)).toBeNull();
    expect(screen.getByText("Seen again just now. Confidence updated.")).toBeTruthy();
    expect(latest("setRoute").targetId).toBe("fresh");
  });

  it("shows one rounded score on the list, map, details, and route, decaying locally each second", async () => {
    const pill = () => latest("setPills").pills.find((p) => p.id === "fresh")?.label;
    await mount();
    expect(screen.getByRole("button", { name: /^65% open\. Seen 1 min ago/ })).toBeTruthy();
    expect(pill()).toBe("65% open");

    await fireEvent.press(screen.getByRole("button", { name: /^65% open\./ }));
    await screen.findByText("Two-hour parking allowed now.");
    expect(screen.getByLabelText("Chance the spot is open: 65 percent")).toBeTruthy();

    // 89.65 s old at 93%: crosses 64.5% between two and three seconds later.
    for (let s = 0; s < 3; s += 1) await tick(1_000);
    expect(screen.getByLabelText("Chance the spot is open: 64 percent")).toBeTruthy();
    expect(pill()).toBe("64% open");

    await fireEvent.press(screen.getByText("Route here"));
    await act(async () => {});
    expect(screen.getByText("64% open")).toBeTruthy();
    const status = () => screen.getByText(/Still showing open|Confidence is falling/);
    expect(status().props.children).toBe("Still showing open.");

    for (let s = 0; s < 4; s += 1) await tick(1_000);
    expect(screen.getByText("63% open")).toBeTruthy();
    expect(pill()).toBe("63% open");
    const announced = status().props.children;
    expect(announced).toMatch(/Confidence is falling/);
    await tick(1_000);
    expect(status().props.children).toBe(announced);
    expect(status().props.accessibilityLiveRegion).toBe("polite");
    expect(mockFetch.mock.calls.filter(([url]) => url.includes("/nearby"))).toHaveLength(1);
  });

  it("expands the camera through its existing draggable host", async () => {
    await mount();
    expect(mockPipExpanded).toBe(false);

    await act(async () => { mockCameraProps.onExpandedChange?.(true); });

    expect(mockPipExpanded).toBe(true);
  });
});
