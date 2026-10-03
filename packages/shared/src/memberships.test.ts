import { describe, expect, it } from "vitest";
import { duePeriods, membershipPeriod, membershipPeriodStart } from "./memberships";

describe("membership periods", () => {
  it("bill on the sign-up day each month, or the last day of a shorter month", () => {
    expect([0, 1, 2, 3].map((k) => membershipPeriodStart("2026-10-15", k))).toEqual(["2026-10-15", "2026-11-15", "2026-12-15", "2027-01-15"]);
    expect([0, 1, 2, 3].map((k) => membershipPeriodStart("2027-01-31", k))).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(membershipPeriodStart("2028-01-30", 1)).toBe("2028-02-29"); // leap year
  });
  it("run until the day before the next bill", () => {
    expect(membershipPeriod("2026-10-15", 0)).toEqual({ start: "2026-10-15", end: "2026-11-14" });
    expect(membershipPeriod("2027-01-31", 1)).toEqual({ start: "2027-02-28", end: "2027-03-30" });
  });
  it("lists the months due, stopping at the end date", () => {
    expect(duePeriods("2026-10-15", 1, "2026-10-20", null)).toEqual([]);
    expect(duePeriods("2026-10-15", 1, "2026-12-15", null).map((p) => p.start)).toEqual(["2026-11-15", "2026-12-15"]);
    expect(duePeriods("2026-10-15", 1, "2027-03-01", "2026-11-14")).toEqual([]); // cancelled at the end of the first month
    expect(duePeriods("2026-10-15", 0, "2026-10-15", null)).toEqual([{ k: 0, start: "2026-10-15", end: "2026-11-14" }]);
  });
});
