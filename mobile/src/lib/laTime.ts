// Wall-clock helpers for America/Los_Angeles, where all business times in the
// spec are evaluated. Timestamps themselves stay UTC ISO 8601.

export const LA_TZ = "America/Los_Angeles";

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LA_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type LaParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function laParts(at: Date): LaParts {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

/** The UTC instant for an LA wall-clock time on the LA calendar day of `on` (+ dayOffset). */
export function laWallTime(hour: number, minute: number, on: Date, dayOffset = 0): Date {
  const d = laParts(on);
  const guess = Date.UTC(d.year, d.month - 1, d.day + dayOffset, hour, minute);
  // Shift by the zone's offset at that instant (handles DST).
  const seen = laParts(new Date(guess));
  const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
  return new Date(guess - (seenUtc - guess));
}

/** Next occurrence of an LA wall-clock time, strictly after `now`. */
export function nextLaTime(hour: number, minute: number, now: Date): Date {
  const today = laWallTime(hour, minute, now);
  return today.getTime() > now.getTime() ? today : laWallTime(hour, minute, now, 1);
}

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: LA_TZ, hour: "numeric", minute: "2-digit" });

/** "6:00 PM" in LA time. */
export function formatLaClock(iso: string | Date): string {
  return clockFmt.format(typeof iso === "string" ? new Date(iso) : iso);
}

/** "HH:MM" -> minutes after midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** "08:00" -> "8 AM", "22:30" -> "10:30 PM". */
export function formatHhmm(hhmm: string): string {
  const total = hhmmToMinutes(hhmm);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

/** Whether `now` falls inside a same-day or overnight LA window. */
export function inLaWindow(start: string, end: string, now: Date): boolean {
  const p = laParts(now);
  const cur = p.hour * 60 + p.minute;
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}
