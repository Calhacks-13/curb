import type { FindOption } from "@/features/find/options";
import { replacementFor, requestRoute } from "@/features/find/route";

const opt = (id: string, kind: FindOption["kind"], lng: number): FindOption => ({
  id,
  kind,
  title: id,
  detail: "",
  trailing: "",
  position: [lng, 37.8],
  ring: [],
  distanceM: Math.abs(lng) * 10,
});

const T: [number, number] = [-122.438, 37.8];

describe("replacementFor", () => {
  const alt = opt("alt", "fresh", -122.437);
  const far = opt("far", "fresh", -122.43);

  it("stays quiet while the routed spot is still fresh or aging", () => {
    expect(replacementFor("t", T, [opt("t", "fresh", -122.438), alt])).toBeNull();
    expect(replacementFor("t", T, [opt("t", "aging", -122.438), alt])).toBeNull();
  });

  it("offers the closest fresh opening when the target is taken", () => {
    const r = replacementFor("t", T, [far, alt, opt("stale", "stale", -122.4381)]);
    expect(r?.reason).toBe("taken");
    expect(r?.alternative?.id).toBe("alt");
  });

  it("offers a replacement when confidence collapses to stale", () => {
    const r = replacementFor("t", T, [opt("t", "stale", -122.438), alt]);
    expect(r).toEqual({ reason: "aging", alternative: alt });
  });

  it("never suggests a stale spot or a driveway, and says when there's nothing", () => {
    const r = replacementFor("t", T, [opt("s", "stale", -122.4), opt("d", "driveway", -122.4)]);
    expect(r).toEqual({ reason: "taken", alternative: null });
  });
});

describe("requestRoute", () => {
  afterEach(() => jest.restoreAllMocks());

  it("asks Mapbox Directions for a driving route and ends it at the bay", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ routes: [{ geometry: { coordinates: [[0, 0], [1, 1]] }, duration: 240, distance: 900 }] }),
    } as Response);
    const r = await requestRoute([0, 0], [1.0001, 1.0001], "pk.test");
    expect(fetchMock.mock.calls[0][0]).toContain("/directions/v5/mapbox/driving/0,0;1.0001,1.0001");
    expect(r.line.at(-1)).toEqual([1.0001, 1.0001]);
    expect(r).toMatchObject({ durationS: 240, distanceM: 900 });
  });

  it("fails loudly when there's no route", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue({ ok: true, json: async () => ({ routes: [] }) } as unknown as Response);
    await expect(requestRoute([0, 0], [1, 1], "pk.test")).rejects.toThrow("No route found");
  });
});
