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
