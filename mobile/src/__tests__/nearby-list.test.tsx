import { render } from "@testing-library/react-native";

import { NearbyList } from "@/components/find/NearbyList";
import type { FindOption } from "@/features/find/options";

const options: FindOption[] = [
  { id: "spot-1", kind: "fresh", title: "Spot 1", detail: "First nearby opening", trailing: "50 ft", position: [-122.4, 37.8], ring: [], distanceM: 15 },
  { id: "spot-2", kind: "fresh", title: "Spot 2", detail: "Second nearby opening", trailing: "100 ft", position: [-122.4, 37.8], ring: [], distanceM: 30 },
  { id: "spot-3", kind: "aging", title: "Spot 3", detail: "Third nearby opening", trailing: "150 ft", position: [-122.4, 37.8], ring: [], distanceM: 45 },
  { id: "spot-4", kind: "stale", title: "Spot 4", detail: "Fourth nearby opening", trailing: "200 ft", position: [-122.4, 37.8], ring: [], distanceM: 60 },
  { id: "spot-5", kind: "fresh", title: "Spot 5", detail: "Newly found nearby opening", trailing: "250 ft", position: [-122.4, 37.8], ring: [], distanceM: 75 },
];

describe("NearbyList", () => {
  it("shows every nearby option, including a newly found fifth spot", async () => {
    const view = await render(<NearbyList options={options} load="ready" onOpen={() => {}} onRetry={() => {}} />);

    expect(view.getByRole("button", { name: "Spot 5. Newly found nearby opening. 250 ft" })).toBeTruthy();
  });

  it("leads a curb row with its percentage and no second availability subtitle", async () => {
    const curb: FindOption = { ...options[0], title: "82% open", detail: "Seen 18 sec ago • 2 min walk", confidencePercent: 82 };
    const view = await render(<NearbyList options={[curb]} load="ready" onOpen={() => {}} onRetry={() => {}} />);

    expect(view.getByRole("button", { name: "82% open. Seen 18 sec ago • 2 min walk. 50 ft" })).toBeTruthy();
    expect(view.queryByText(/Likely open/)).toBeNull();
  });
});
