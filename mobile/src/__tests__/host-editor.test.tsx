import { render, screen } from "@testing-library/react-native";

import type { Booking, Driveway } from "@/api/types";
import { DrivewayEditor } from "@/features/host/DrivewayEditor";

const driveway = (state: Driveway["state"]): Driveway => ({
  id: "driveway_demo_1",
  owner_id: "owner_demo",
  location: { type: "Point", coordinates: [-122.4364, 37.8012] },
  photo_url: null,
  price_usdc: "8.00",
  availability_start: "08:00",
  availability_end: "22:00",
  availability_timezone: "America/Los_Angeles",
  state,
  held_by_user_id: state === "HELD" || state === "BOOKED" ? "driver_demo" : null,
  version: 3,
});

const booking: Booking = {
  id: "b1",
  idempotency_key: "k",
  driveway_id: "driveway_demo_1",
  driver_id: "driver_demo",
  state: "CONFIRMED",
  amount_usdc: "8.00",
  network: "base-sepolia",
  transaction_hash: "0xabc1230000000000000000000000000000000000000000000000000000def456",
  created_at: "2026-10-24T21:00:00Z",
  confirmed_at: "2026-10-24T21:00:08Z",
  version: 3,
};

describe("owner driveway editor", () => {
  it("shows Payment in progress with recovery while a driver holds it", async () => {
    await render(<DrivewayEditor driveway={driveway("HELD")} booking={null} onConflict={() => {}} />);
    expect(screen.getAllByText("Payment in progress").length).toBeGreaterThan(0);
    expect(screen.getByText("Return to available")).toBeTruthy();
    expect(screen.queryByText("Save changes")).toBeNull();
  });

  it("shows the receipt with the testnet transaction once booked", async () => {
    await render(<DrivewayEditor driveway={driveway("BOOKED")} booking={booking} onConflict={() => {}} />);
    expect(screen.getByText("Booked")).toBeTruthy();
    expect(screen.getByText("8.00 USDC")).toBeTruthy();
    expect(screen.getByText("0xabc1…f456")).toBeTruthy();
  });

  it("lets the owner edit an available listing", async () => {
    await render(<DrivewayEditor driveway={driveway("AVAILABLE")} booking={null} onConflict={() => {}} />);
    expect(screen.getByText("Listed")).toBeTruthy();
    expect(screen.getByText("Save changes")).toBeTruthy();
  });
});
