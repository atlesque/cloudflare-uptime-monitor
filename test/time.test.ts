import { describe, expect, it } from "vitest";
import { dueReportWeek, reportHour, reportWindowOpen } from "../src/report";
import { formatDuration, getTimeZone, setTimeZone, weekStartContaining, zonedToUtc } from "../src/time";

describe("Europe/Brussels week boundaries", () => {
  it("converts local wall-clock times in summer and winter", () => {
    expect(zonedToUtc(2026, 9, 28, 8)).toBe(Date.UTC(2026, 8, 28, 6)); // CEST, UTC+2
    expect(zonedToUtc(2026, 11, 2, 8)).toBe(Date.UTC(2026, 10, 2, 7)); // CET, UTC+1
  });

  it("finds Monday 00:00 local time of the containing week", () => {
    expect(weekStartContaining(Date.UTC(2026, 8, 30, 10))).toBe(Date.UTC(2026, 8, 27, 22));
    // Sunday 23:30 local is still in the week that started the previous Monday.
    expect(weekStartContaining(Date.UTC(2026, 9, 4, 21, 30))).toBe(Date.UTC(2026, 8, 27, 22));
    // Monday 00:30 local starts a new week.
    expect(weekStartContaining(Date.UTC(2026, 9, 4, 22, 30))).toBe(Date.UTC(2026, 9, 4, 22));
  });

  it("is not due before Monday 08:00 local time", () => {
    expect(dueReportWeek(Date.UTC(2026, 8, 28, 5, 59))).toBeNull();
    expect(dueReportWeek(Date.UTC(2026, 8, 28, 6, 0))).toEqual({
      weekStart: Date.UTC(2026, 8, 20, 22),
      weekEnd: Date.UTC(2026, 8, 27, 22),
    });
  });

  it("covers the completed week for the rest of the week after Monday 08:00", () => {
    expect(dueReportWeek(Date.UTC(2026, 9, 2, 12))).toEqual({
      weekStart: Date.UTC(2026, 8, 20, 22),
      weekEnd: Date.UTC(2026, 8, 27, 22),
    });
  });

  it("handles the week in which clocks go back", () => {
    // Clocks went back on Sunday 25 October 2026; the report is due Monday 26 October 08:00 CET.
    expect(dueReportWeek(Date.UTC(2026, 9, 26, 6, 59))).toBeNull();
    const week = dueReportWeek(Date.UTC(2026, 9, 26, 7, 0))!;
    expect(week).toEqual({ weekStart: Date.UTC(2026, 9, 18, 22), weekEnd: Date.UTC(2026, 9, 25, 23) });
    expect(week.weekEnd - week.weekStart).toBe((7 * 24 + 1) * 3_600_000);
  });

  it("handles the week in which clocks go forward", () => {
    // Clocks go forward on Sunday 28 March 2027.
    const week = dueReportWeek(Date.UTC(2027, 2, 29, 6, 0))!;
    expect(week).toEqual({ weekStart: Date.UTC(2027, 2, 21, 23), weekEnd: Date.UTC(2027, 2, 28, 22) });
  });
});

describe("durations", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [60_000, "1m"],
    [59 * 60_000, "59m"],
    [65 * 60_000, "1h 05m"],
    [26 * 3_600_000, "1d 2h"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe("configurable report schedule", () => {
  it("opens the window for two hours from REPORT_HOUR on local Mondays only", () => {
    expect(reportWindowOpen(Date.UTC(2026, 8, 28, 5, 59), 8)).toBe(false); // 07:59 CEST
    expect(reportWindowOpen(Date.UTC(2026, 8, 28, 6, 0), 8)).toBe(true); // 08:00 CEST
    expect(reportWindowOpen(Date.UTC(2026, 8, 28, 7, 55), 8)).toBe(true); // 09:55 CEST
    expect(reportWindowOpen(Date.UTC(2026, 8, 28, 8, 0), 8)).toBe(false); // 10:00 CEST
    expect(reportWindowOpen(Date.UTC(2026, 8, 29, 6, 0), 8)).toBe(false); // Tuesday
    expect(reportWindowOpen(Date.UTC(2026, 8, 28, 13, 0), 15)).toBe(true); // 15:00 CEST
  });

  it("honours a custom hour when deciding what is due", () => {
    expect(dueReportWeek(Date.UTC(2026, 8, 28, 6, 0), 9)).toBeNull();
    expect(dueReportWeek(Date.UTC(2026, 8, 28, 7, 0), 9)).not.toBeNull();
  });

  it("parses REPORT_HOUR, falling back to 8 for invalid values", () => {
    const hour = (v: string | undefined) => reportHour({ REPORT_HOUR: v } as Env);
    expect(hour("6")).toBe(6);
    expect(hour("0")).toBe(0);
    expect(hour("21")).toBe(21);
    for (const bad of [undefined, "", "abc", "-1", "22", "24", "7.5"]) expect(hour(bad)).toBe(8);
  });

  it("falls back to UTC for an empty or invalid TIME_ZONE", () => {
    const before = getTimeZone();
    try {
      setTimeZone("America/New_York");
      expect(getTimeZone()).toBe("America/New_York");
      setTimeZone("Not/AZone");
      expect(getTimeZone()).toBe("UTC");
      setTimeZone("");
      expect(getTimeZone()).toBe("UTC");
    } finally {
      setTimeZone(before);
    }
  });
});
