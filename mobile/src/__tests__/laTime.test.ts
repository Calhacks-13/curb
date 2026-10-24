import { formatHhmm, inLaWindow, laWallTime } from "@/lib/laTime";

describe("America/Los_Angeles wall time", () => {
  it("maps 6 PM LA to the right UTC instant in daylight time and standard time", () => {
    expect(laWallTime(18, 0, new Date("2026-10-24T20:00:00Z")).toISOString()).toBe("2026-10-25T01:00:00.000Z");
    expect(laWallTime(18, 0, new Date("2026-11-10T20:00:00Z")).toISOString()).toBe("2026-11-11T02:00:00.000Z");
  });

  it("evaluates availability windows in LA time", () => {
    // 7:30 PM PDT
    const evening = new Date("2026-10-25T02:30:00Z");
    expect(inLaWindow("08:00", "22:00", evening)).toBe(true);
    expect(inLaWindow("08:00", "18:00", evening)).toBe(false);
    expect(inLaWindow("22:00", "06:00", new Date("2026-10-25T06:00:00Z"))).toBe(true); // 11 PM PDT
  });

  it("formats HH:MM for people", () => {
    expect(formatHhmm("08:00")).toBe("8 AM");
    expect(formatHhmm("22:30")).toBe("10:30 PM");
    expect(formatHhmm("00:00")).toBe("12 AM");
  });
});

describe("laWindowToUtc / toLaHhmm", () => {
  const { laWindowToUtc, toLaHhmm } = jest.requireActual<typeof import("@/lib/laTime")>("@/lib/laTime");

  it("sends today's same-day window as UTC instants", () => {
    const now = new Date("2026-10-24T19:00:00Z"); // noon PDT
    expect(laWindowToUtc("08:00", "18:00", now)).toEqual({ start: "2026-10-24T15:00:00.000Z", end: "2026-10-25T01:00:00.000Z" });
  });

  it("uses last night's overnight window when it's still running", () => {
    const now = new Date("2026-10-24T08:00:00Z"); // 1 AM PDT
    expect(laWindowToUtc("22:00", "03:00", now)).toEqual({ start: "2026-10-24T05:00:00.000Z", end: "2026-10-24T10:00:00.000Z" });
  });

  it("rolls to tomorrow once today's window has ended", () => {
    const now = new Date("2026-10-25T02:00:00Z"); // 7 PM PDT
    expect(laWindowToUtc("08:00", "18:00", now).start).toBe("2026-10-25T15:00:00.000Z");
  });

  it("reads UTC timestamps back as LA HH:MM, across DST", () => {
    expect(toLaHhmm("2026-10-24T15:00:00Z")).toBe("08:00"); // PDT
    expect(toLaHhmm("2026-11-02T16:00:00Z")).toBe("08:00"); // PST
    expect(toLaHhmm("07:30")).toBe("07:30");
  });
});
