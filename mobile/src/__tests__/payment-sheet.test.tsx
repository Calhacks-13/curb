import { fireEvent, render, screen } from "@testing-library/react-native";

import type { Booking, Driveway, WalletInfo } from "@/api/types";
import { PaymentSheet } from "@/components/find/PaymentSheet";

const driveway = { availability_start: "00:00", availability_end: "23:59" } as Driveway;
const booking = { id: "booking_1", amount_usdc: "0.75" } as Booking;
const wallet = (balance: string): WalletInfo => ({
  network: "base-sepolia",
  payer: { name: "curb-demo-driver", address: "0x8413A66C95c9b4765fb52194eabdE4D7F83F6cEb", usdc_balance: balance, explorer_url: "https://x" },
  payee: { name: "curb-demo-owner", address: "0x21749B342fc0C6263743Ab8b1e09dCB93937d775" },
});

const renderSheet = async (overrides: Partial<Parameters<typeof PaymentSheet>[0]> = {}) => {
  const props = {
    driveway,
    booking,
    phase: "review" as const,
    error: null,
    demo: false,
    wallet: wallet("7"),
    walletFailed: false,
    topUp: "idle" as const,
    step: null,
    onTopUp: jest.fn(),
    onPay: jest.fn(),
    onCancel: jest.fn(),
    ...overrides,
  };
  await render(<PaymentSheet {...props} />);
  return { props };
};

describe("PaymentSheet", () => {
  it("shows the wallet, payee and an approve button", async () => {
    const { props } = await renderSheet();
    await screen.findByText("Coinbase wallet");
    expect(screen.getByText("7.00 USDC")).toBeTruthy();
    expect(screen.getByText(/Owner 0x2174/)).toBeTruthy();
    await fireEvent.press(screen.getByText("Approve 0.75 USDC"));
    expect(props.onPay).toHaveBeenCalled();
  });

  it("blocks approval and offers a top-up when the balance is short", async () => {
    const { props } = await renderSheet({ wallet: wallet("0.2") });
    await screen.findByText("Not enough USDC for this booking.");
    await fireEvent.press(screen.getByText("Approve 0.75 USDC"));
    expect(props.onPay).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText("Add test USDC"));
    expect(props.onTopUp).toHaveBeenCalled();
  });

  it("keeps retry payment enabled after a failed attempt with a short balance", async () => {
    const { props } = await renderSheet({
      phase: "failed",
      error: "Not enough USDC in the wallet.",
      wallet: wallet("0.2"),
    });

    await fireEvent.press(screen.getByText("Retry payment"));

    expect(props.onPay).toHaveBeenCalledTimes(1);
  });

  it("walks the settlement steps while processing", async () => {
    await renderSheet({ phase: "processing", step: "signed" });
    await screen.findByText("Paying the owner");
    expect(screen.getByLabelText("Payment approved: done")).toBeTruthy();
    expect(screen.getByLabelText("Signed by your wallet: done")).toBeTruthy();
    expect(screen.getByLabelText("Settled on Base: current")).toBeTruthy();
    expect(screen.getByLabelText("Driveway booked: pending")).toBeTruthy();
  });
});
