import { DEMO_IDS } from "@/api/types";
import { createDemoApi } from "@/demo/demoApi";

jest.useFakeTimers();

async function freshDriveway(api = createDemoApi()) {
  const res = await api.nearby(37.8, -122.4366);
  return { api, d: res.driveways.find((x) => x.id === DEMO_IDS.driveway)! };
}

describe("demo nearby query", () => {
  it("returns only supply within the radius, like the backend", async () => {
    const api = createDemoApi();
    const near = await api.nearby(37.8007, -122.4372);
    expect(near.spaces.length).toBeGreaterThan(0);
    expect(near.driveways).toHaveLength(1);
    const far = await api.nearby(37.7749, -122.4194); // downtown SF, ~3 km away
    expect(far).toMatchObject({ zones: [], spaces: [], driveways: [] });
    const tight = await api.nearby(37.8007, -122.4372, 50);
    expect(tight.spaces.length).toBeLessThan(near.spaces.length);
  });
});

describe("demo driveway marketplace", () => {
  it("treats repeated cancellation as the same release", async () => {
    const { api, d } = await freshDriveway();
    const booking = await api.holdDriveway(d.id, d.version);

    const released = await api.cancelHold(d.id, booking.id);
    const repeated = await api.cancelHold(d.id, booking.id);

    expect(repeated).toEqual(released);
    expect(repeated.state).toBe("AVAILABLE");
  });

  it("goes AVAILABLE -> HELD -> BOOKED and pays only once for repeated requests", async () => {
    const { api, d } = await freshDriveway();
    const booking = await api.holdDriveway(d.id, d.version);
    expect(booking.state).toBe("PENDING_PAYMENT");

    const first = api.executePayment(booking.id);
    const repeat = await api.executePayment(booking.id); // while processing
    expect(repeat.state).toBe("PROCESSING");
    jest.advanceTimersByTime(3000);
    const confirmed = await first;
    expect(confirmed.state).toBe("CONFIRMED");
    expect((await api.executePayment(booking.id)).id).toBe(booking.id);

    const after = (await api.nearby(37.8, -122.4366)).driveways[0];
    expect(after.state).toBe("BOOKED");
  });

  it("rejects a stale expected_version with 409", async () => {
    const { api, d } = await freshDriveway();
    await api.holdDriveway(d.id, d.version);
    await expect(api.holdDriveway(d.id, d.version)).rejects.toMatchObject({ status: 409 });
  });

  it("blocks owner recovery while payment is processing", async () => {
    const { api, d } = await freshDriveway();
    const booking = await api.holdDriveway(d.id, d.version);
    const held = (await api.nearby(37.8, -122.4366)).driveways[0];
    const paying = api.executePayment(booking.id);
    await expect(api.recoverDriveway(d.id, held.version)).rejects.toMatchObject({ status: 409 });
    jest.advanceTimersByTime(3000);
    await paying;
  });
});
