import type { FindOption } from "@/features/find/options";
import { replacementFor, requestRoute } from "@/features/find/route";

const opt = (id: string, kind: FindOption["kind"], lng: number, confidencePercent?: number): FindOption => ({
  id,
  kind,
  title: id,
  detail: "",
  trailing: "",
  position: [lng, 37.8],
  ring: [],
  distanceM: Math.abs(lng) * 10,
  confidencePercent: kind === "driveway" ? undefined : (confidencePercent ?? 80),
});

const T: [number, number] = [-122.438, 37.8];

describe("replacementFor", () => {
  const alt = opt("alt", "fresh", -122.437);
  const far = opt("far", "fresh", -122.43);

  it("stays quiet while the routed spot displays at least 50%", () => {
    expect(replacementFor("t", T, [opt("t", "fresh", -122.438), alt])).toBeNull();
    expect(replacementFor("t", T, [opt("t", "aging", -122.438, 50), alt])).toBeNull();
  });

  it("offers a replacement once the displayed percentage is 49", () => {
    const r = replacementFor("t", T, [opt("t", "aging", -122.438, 49), alt]);
    expect(r).toEqual({ reason: "confidence", alternative: alt });
  });

  it("offers the closest fresh opening when the target is taken", () => {
    const r = replacementFor("t", T, [far, alt, opt("stale", "stale", -122.4381, 30)]);
    expect(r?.reason).toBe("taken");
    expect(r?.alternative?.id).toBe("alt");
  });

  it("rejects alternatives below 50% and keeps freshness then distance ranking", () => {
    const weakNear = opt("weak", "fresh", -122.4379, 49);
    const agingNear = opt("agingNear", "aging", -122.4379, 60);
    const freshFar = opt("freshFar", "fresh", -122.43, 55);
    const r = replacementFor("t", T, [weakNear, agingNear, freshFar]);
    expect(r?.alternative?.id).toBe("freshFar");
    expect(replacementFor("t", T, [weakNear, agingNear])?.alternative?.id).toBe("agingNear");
  });

  it("never suggests a driveway, and says when there's nothing", () => {
    const r = replacementFor("t", T, [opt("s", "stale", -122.4, 20), opt("d", "driveway", -122.4)]);
    expect(r).toEqual({ reason: "taken", alternative: null });
  });

  it("does not apply the confidence rule to a routed driveway", () => {
    expect(replacementFor("d", T, [opt("d", "driveway", -122.438), alt])).toBeNull();
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
