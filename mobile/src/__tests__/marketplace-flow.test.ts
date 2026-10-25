import { act, renderHook } from "@testing-library/react-native";

import { getApi } from "@/api/client";
import { DEMO_IDS, type Driveway } from "@/api/types";
import { useDrivewayBooking } from "@/features/find/useDrivewayBooking";
import { draftOf, shiftWindow } from "@/features/host/useDriveway";

jest.useFakeTimers();

async function currentDriveway(): Promise<Driveway> {
  const res = await getApi().nearby(37.8, -122.4366);
  return res.driveways.find((d) => d.id === DEMO_IDS.driveway)!;
}

describe("driver driveway checkout", () => {
  it("reports a successful cancellation so the reservation sheet can close", async () => {
    const { result } = await renderHook(() => useDrivewayBooking());
    const driveway = await currentDriveway();

    await act(async () => {
      await result.current.reserve(driveway);
    });

    let cancelled = false;
    await act(async () => {
      cancelled = await result.current.cancel(driveway);
    });

    expect(cancelled).toBe(true);
    expect(result.current.checkout.phase).toBe("detail");
    expect((await currentDriveway()).state).toBe("AVAILABLE");
  });

  it("holds, fails without losing the hold, retries once, and confirms", async () => {
    const api = getApi();
    const onConfirmed = jest.fn();
    const { result } = await renderHook(() => useDrivewayBooking(onConfirmed));

    const held = await currentDriveway();
    await act(async () => {
      await result.current.reserve(held);
    });
    expect(result.current.checkout.phase).toBe("review");
    expect((await currentDriveway()).state).toBe("HELD");

    // First attempt fails: the hold stays and the sheet offers Retry / Cancel.
    const realPay = api.executePayment.bind(api);
    const spy = jest.spyOn(api, "executePayment").mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      await result.current.pay();
    });
    expect(result.current.checkout.phase).toBe("failed");
    expect((await currentDriveway()).state).toBe("HELD");

    spy.mockImplementation(realPay);
    await act(async () => {
      const paying = result.current.pay();
      jest.advanceTimersByTime(3000);
      await paying;
    });
    expect(result.current.checkout.phase).toBe("confirmed");
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect((await currentDriveway()).state).toBe("BOOKED");
  });
});

describe("owner availability window", () => {
  const base = draftOf({
    id: "d",
    owner_id: "o",
    location: { type: "Point", coordinates: [0, 0] },
    photo_url: null,
    price_usdc: "8.00",
    availability_start: "08:00",
    availability_end: "22:00",
    availability_timezone: "America/Los_Angeles",
    state: "AVAILABLE",
    held_by_user_id: null,
    version: 1,
  });

  it("moves window edges by the hour", () => {
    expect(shiftWindow(base, "start", 60).start).toBe("09:00");
    expect(shiftWindow(base, "end", -60).end).toBe("21:00");
  });

  it("keeps the window between 1 and 23 hours, wrapping past midnight", () => {
    const tight = { ...base, start: "20:00", end: "21:00" };
    expect(shiftWindow(tight, "start", 60)).toEqual(tight);
    expect(shiftWindow(tight, "end", -60)).toEqual(tight);
    expect(shiftWindow({ ...base, end: "23:00" }, "end", 60).end).toBe("00:00");
    expect(shiftWindow({ ...base, start: "07:00", end: "03:00" }, "end", 60).end).toBe("04:00");
    expect(shiftWindow({ ...base, start: "07:00", end: "06:00" }, "end", 60)).toMatchObject({ end: "06:00" });
  });
});
