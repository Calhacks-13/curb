import { render, screen } from "@testing-library/react-native";

import type { SpaceDetail } from "@/api/types";
import { isBlankRule, SpaceDetailSheet } from "@/components/find/SpaceDetailSheet";
import type { FindOption } from "@/features/find/options";

const option: FindOption = {
  id: "seed_spot_1",
  kind: "fresh",
  title: "Likely open",
  detail: "",
  trailing: "",
  position: [-122.4475, 37.8022],
  ring: [],
  distanceM: 120,
};

const blankRule = {
  id: "seg_baker_bay_1",
  summary: null as unknown as string,
  max_minutes: null,
  next_change_at: null,
  next_change_summary: null,
  payment_text: null,
  permit_text: null,
  interpretation_confidence: 0,
  last_validated_at: "2026-10-24T18:00:00Z",
};

const detail = (rule: SpaceDetail["rule"]) =>
  ({ space: { base_confidence: 0.88 }, zone: {}, rule }) as unknown as SpaceDetail;

const renderSheet = (rule: SpaceDetail["rule"]) =>
  render(
    <SpaceDetailSheet
      option={option}
      ageSeconds={20}
      load={{ status: "ready", detail: detail(rule) }}
      routing={false}
      onRoute={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
    />,
  );

describe("spot detail rule card", () => {
  it("treats a rule with nothing read off the sign as blank", () => {
    expect(isBlankRule(blankRule)).toBe(true);
    expect(isBlankRule(null)).toBe(true);
    expect(isBlankRule({ ...blankRule, max_minutes: 120 })).toBe(false);
  });

  it("says no sign was read instead of rendering an empty card", async () => {
    await renderSheet(blankRule);
    expect(screen.getByText("No sign read for this curb yet")).toBeTruthy();
  });

  it("shows the rule rows when the sign was read", async () => {
    await renderSheet({ ...blankRule, summary: "2 hr parking until 6 PM", max_minutes: 120 });
    expect(screen.getByText("2 hr parking until 6 PM")).toBeTruthy();
    expect(screen.getByText("2 hr")).toBeTruthy();
    expect(screen.queryByText("No sign read for this curb yet")).toBeNull();
  });
});


it("shows the calendar date of a future restriction instead of a bare clock", async () => {
  await renderSheet({ ...blankRule, summary: "Street cleaning on the third Tuesday, 11 AM–1 PM",
    next_change_at: "2026-11-17T19:00:00Z" });
  expect(screen.getByText("Next rule change")).toBeTruthy();
  expect(screen.getByText("Tue, Nov 17, 2026 at 11 AM PT")).toBeTruthy();
  expect(screen.queryByText("Changes")).toBeNull();
});
