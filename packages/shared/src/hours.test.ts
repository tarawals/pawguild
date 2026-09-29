import { describe, expect, it } from "vitest";
import { describeHoursProblem, formatTimeOfDay, hoursProblem, localParts, summarizeHours, type OpeningHours } from "./hours";

const TZ = "America/New_York";
const weekdays: OpeningHours[] = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: "07:00:00", closesAt: "19:00:00" }));
const hours: OpeningHours[] = [...weekdays, { weekday: 6, opensAt: "08:00", closesAt: "17:00" }];

describe("localParts", () => {
  it("uses the location's calendar, across DST", () => {
    expect(localParts(new Date("2026-12-07T03:30:00Z"), TZ)).toEqual({ date: "2026-12-06", weekday: 0, time: "22:30" });
    expect(localParts(new Date("2026-07-06T11:00:00Z"), TZ)).toEqual({ date: "2026-07-06", weekday: 1, time: "07:00" });
    expect(localParts(new Date("2026-07-06T04:00:00Z"), TZ).time).toBe("00:00");
  });
});

describe("hoursProblem", () => {
  const at = (local: string, offset = "-05:00") => new Date(`${local}${offset}`);
  it("allows anything when no hours are set, except closures", () => {
    expect(hoursProblem(at("2026-12-06T03:00"), TZ, [], [])).toBeNull();
    expect(hoursProblem(at("2026-12-25T10:00"), TZ, [], [{ closedOn: "2026-12-25", reason: "Christmas" }]))
      .toMatchObject({ kind: "closure", reason: "Christmas" });
  });
  it("includes opening and closing times", () => {
    expect(hoursProblem(at("2026-12-07T07:00"), TZ, hours, [])).toBeNull();
    expect(hoursProblem(at("2026-12-07T19:00"), TZ, hours, [])).toBeNull();
    expect(hoursProblem(at("2026-12-07T06:59"), TZ, hours, [])).toMatchObject({ kind: "outside_hours", opensAt: "07:00", closesAt: "19:00" });
    expect(hoursProblem(at("2026-12-07T19:01"), TZ, hours, [])).toMatchObject({ kind: "outside_hours" });
  });
  it("treats a weekday without hours as closed", () => {
    expect(hoursProblem(at("2026-12-06T12:00"), TZ, hours, [])).toMatchObject({ kind: "closed_day", weekday: 0 });
    expect(hoursProblem(at("2026-12-05T16:00"), TZ, hours, [])).toBeNull(); // Saturday hours
  });
  it("closures win over regular hours", () => {
    expect(hoursProblem(at("2026-12-07T12:00"), TZ, hours, [{ closedOn: "2026-12-07" }])).toMatchObject({ kind: "closure", reason: null });
  });
});

describe("wording", () => {
  it("formats times and problems for staff", () => {
    expect(formatTimeOfDay("00:05")).toBe("12:05 AM");
    expect(formatTimeOfDay("12:00:00")).toBe("12:00 PM");
    expect(formatTimeOfDay("19:30")).toBe("7:30 PM");
    const p = hoursProblem(new Date("2026-12-07T06:30:00-05:00"), TZ, hours, [])!;
    expect(describeHoursProblem("Drop-off", p)).toBe("Drop-off on Mon, Dec 7 at 6:30 AM is before opening (open 7:00 AM–7:00 PM)");
    const c = hoursProblem(new Date("2026-12-25T10:00:00-05:00"), TZ, hours, [{ closedOn: "2026-12-25", reason: "Christmas" }])!;
    expect(describeHoursProblem("Pick-up", c)).toBe("Pick-up on Fri, Dec 25 at 10:00 AM: the location is closed that day (Christmas)");
    const s = hoursProblem(new Date("2026-12-06T10:00:00-05:00"), TZ, hours, [])!;
    expect(describeHoursProblem("Pick-up", s)).toBe("Pick-up on Sun, Dec 6 at 10:00 AM: the location is closed on Sundays");
  });
  it("summarizes the week", () => {
    expect(summarizeHours([])).toBe("No hours set");
    expect(summarizeHours(hours)).toBe("Mon–Fri 7:00 AM–7:00 PM · Sat 8:00 AM–5:00 PM · Sun closed");
  });
});
