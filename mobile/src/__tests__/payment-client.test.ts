const booking = { id: "booking_1", state: "CONFIRMED", transaction_hash: "0xabc" };

function liveApi(body: unknown) {
  process.env.EXPO_PUBLIC_API_URL = "https://api.test";
  process.env.EXPO_PUBLIC_PAYMENTS_URL = "https://pay.test";
  const fetchMock = jest.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  let api!: import("@/api/client").CurbApi;
  jest.isolateModules(() => {
    api = jest.requireActual<typeof import("@/api/client")>("@/api/client").getApi();
  });
  return { api, fetchMock };
}

afterEach(() => {
  delete process.env.EXPO_PUBLIC_API_URL;
  delete process.env.EXPO_PUBLIC_PAYMENTS_URL;
});

describe("executePayment over HTTP", () => {
  it("calls the payment service and unwraps { booking, explorer_url }", async () => {
    const { api, fetchMock } = liveApi({ booking, explorer_url: "https://sepolia.basescan.org/tx/0xabc" });
    await expect(api.executePayment("booking_1")).resolves.toEqual(booking);
    expect(fetchMock).toHaveBeenCalledWith("https://pay.test/v1/payments/booking_1/execute", expect.objectContaining({ method: "POST" }));
  });

  it("still accepts a bare booking", async () => {
    const { api } = liveApi(booking);
    await expect(api.executePayment("booking_1")).resolves.toEqual(booking);
  });
});

describe("updateDriveway over HTTP", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-24T19:00:00Z") })); // noon PDT
  afterEach(() => jest.useRealTimers());

  it("sends the window as UTC timestamps and reads it back as HH:MM", async () => {
    const view = { id: "driveway_demo_1", availability_start: "2026-10-24T15:00:00Z", availability_end: "2026-10-25T01:00:00Z", version: 2 };
    const { api, fetchMock } = liveApi(view);
    const saved = await api.updateDriveway("driveway_demo_1", {
      expected_version: 1,
      available: true,
      price_usdc: "1.25",
      availability_start: "08:00",
      availability_end: "18:00",
    });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(sent.availability_start).toBe("2026-10-24T15:00:00.000Z");
    expect(sent.availability_end).toBe("2026-10-25T01:00:00.000Z");
    expect(saved).toMatchObject({ availability_start: "08:00", availability_end: "18:00" });
  });
});
