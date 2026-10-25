import { act, renderHook } from "@testing-library/react-native";

import type { CurbApi } from "@/api/client";
import type { Booking, Driveway } from "@/api/types";
import { useDrivewayBooking } from "@/features/find/useDrivewayBooking";

const mockApi = {
  holdDriveway: jest.fn(),
  executePayment: jest.fn(),
  cancelHold: jest.fn(),
} as unknown as CurbApi;

jest.mock("@/api/client", () => ({ getApi: () => mockApi }));

const driveway = { id: "driveway_1", version: 1 } as Driveway;
const booking = {
  id: "booking_1",
  driveway_id: driveway.id,
  state: "PENDING_PAYMENT",
} as Booking;

describe("driveway checkout action serialization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockApi.holdDriveway = jest.fn().mockResolvedValue(booking);
  });

  it("does not start cancellation while a payment retry is already running", async () => {
    let finishPayment!: (value: Booking) => void;
    mockApi.executePayment = jest.fn(() => new Promise<Booking>((resolve) => { finishPayment = resolve; }));
    mockApi.cancelHold = jest.fn();
    const { result } = await renderHook(() => useDrivewayBooking());
    await act(async () => result.current.reserve(driveway));

    let payment!: Promise<void>;
    let cancelled!: boolean;
    await act(async () => {
      payment = result.current.pay();
      cancelled = await result.current.cancel(driveway);
    });

    expect(cancelled).toBe(false);
    expect(mockApi.cancelHold).not.toHaveBeenCalled();
    await act(async () => {
      finishPayment({ ...booking, state: "CONFIRMED" });
      await payment;
    });
  });

  it("coalesces immediate repeated cancellation taps", async () => {
    let finishCancel!: () => void;
    mockApi.cancelHold = jest.fn(() => new Promise<Driveway>((resolve) => {
      finishCancel = () => resolve(driveway);
    }));
    const { result } = await renderHook(() => useDrivewayBooking());
    await act(async () => result.current.reserve(driveway));

    let first!: Promise<boolean>;
    let second!: boolean;
    await act(async () => {
      first = result.current.cancel(driveway);
      second = await result.current.cancel(driveway);
    });

    expect(second).toBe(false);
    expect(mockApi.cancelHold).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishCancel();
      await first;
    });
  });
});
