import { render, screen } from "@testing-library/react-native";

import type { SpaceDetail } from "@/api/types";
import { isBlankRule, SpaceDetailSheet } from "@/components/find/SpaceDetailSheet";
import type { FindOption } from "@/features/find/options";
import type { DetailLoad } from "@/features/find/useSpaceDetail";

const option: FindOption = {
  id: "seed_spot_1",
  kind: "fresh",
  title: "82% open",
  detail: "",
  trailing: "",
  position: [-122.4475, 37.8022],
  ring: [],
  distanceM: 120,
  confidencePercent: 82,
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

const readRule = { ...blankRule, summary: "2 hr parking until 6 PM", max_minutes: 120, interpretation_confidence: 0.74 };

const detail = (rule: SpaceDetail["rule"]) =>
  ({ space: { base_confidence: 0.88, detection_confidence: 0.91 }, zone: {}, rule }) as unknown as SpaceDetail;

const renderSheet = (
  rule: SpaceDetail["rule"],
  { detectionConfidence = 0.91, load }: { detectionConfidence?: number; load?: DetailLoad } = {},
) =>
  render(
    <SpaceDetailSheet
      option={option}
      ageSeconds={18}
      confidencePercent={82}
      detectionConfidence={detectionConfidence}
      load={load ?? { status: "ready", detail: detail(rule) }}
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
    await renderSheet(readRule);
    expect(screen.getByText("2 hr parking until 6 PM")).toBeTruthy();
    expect(screen.getByText("2 hr")).toBeTruthy();
    expect(screen.queryByText("No sign read for this curb yet")).toBeNull();
  });
});

describe("spot detail confidence", () => {
  it("leads with the shared percentage and the approved supporting facts", async () => {
    await renderSheet(readRule);
    expect(screen.getByText("Chance the spot is open")).toBeTruthy();
    expect(screen.getByLabelText("Chance the spot is open: 82 percent")).toBeTruthy();
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByLabelText("Last observed: 18 seconds ago")).toBeTruthy();
    expect(screen.getByLabelText("Detection confidence: 91%")).toBeTruthy();
    expect(screen.getByLabelText("Parking rule confidence: 74%")).toBeTruthy();
    expect(screen.getByText("Route here")).toBeTruthy();
  });

  it("omits location accuracy, the subtitle under the percentage, and the CV disclaimer", async () => {
    await renderSheet(readRule);
    expect(screen.queryByText(/accuracy/i)).toBeNull();
    expect(screen.queryByText(/Likely open/)).toBeNull();
    expect(screen.queryByText(/min walk/)).toBeNull();
    expect(screen.queryByText(/Computer vision estimate/)).toBeNull();
  });

  it("shows a legacy zero detection confidence as 0%", async () => {
    await renderSheet(readRule, { detectionConfidence: 0 });
    expect(screen.getByLabelText("Detection confidence: 0%")).toBeTruthy();
  });

  it.each([
    ["missing", null],
    ["blank", blankRule],
  ])("shows an em dash for a %s rule's confidence", async (_, rule) => {
    await renderSheet(rule);
    expect(screen.getByLabelText("Parking rule confidence: —")).toBeTruthy();
  });

  it("shows an em dash for rule confidence while the rule is loading", async () => {
    await renderSheet(readRule, { load: { status: "loading" } });
    expect(screen.getByLabelText("Parking rule confidence: —")).toBeTruthy();
    expect(screen.getByText("Reading the curb rules")).toBeTruthy();
  });
});
