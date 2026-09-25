import { describe, expect, it } from "vitest";
import { billableQuantity, calendarDate, estimateReservation } from "./pricing";

const NY = "America/New_York";

describe("pricing", () => {
  it("uses the business's local calendar date", () => {
    // 02:00 UTC on Mar 2 is still Mar 1 in New York.
    expect(calendarDate(new Date("2026-03-02T02:00:00Z"), NY)).toBe("2026-03-01");
  });

  it("counts boarding nights", () => {
    const q = (a: string, b: string) => billableQuantity("per_night", new Date(a), new Date(b), NY);
    expect(q("2026-07-01T14:00:00-04:00", "2026-07-04T11:00:00-04:00")).toBe(3);
    expect(q("2026-07-01T08:00:00-04:00", "2026-07-01T18:00:00-04:00")).toBe(1); // same-day minimum
    // Across the DST change (Nov 1 2026) still counts calendar nights.
    expect(q("2026-10-31T15:00:00-04:00", "2026-11-02T10:00:00-05:00")).toBe(2);
  });

  it("counts daycare days inclusively", () => {
    const q = (a: string, b: string) => billableQuantity("per_day", new Date(a), new Date(b), NY);
    expect(q("2026-07-01T08:00:00-04:00", "2026-07-01T18:00:00-04:00")).toBe(1);
    expect(q("2026-07-01T08:00:00-04:00", "2026-07-03T18:00:00-04:00")).toBe(3);
  });

  it("charges a visit once", () => {
    expect(billableQuantity("per_visit", new Date("2026-07-01T10:00:00Z"), new Date("2026-07-01T11:30:00Z"), NY)).toBe(1);
  });

  it("rejects an end before the start", () => {
    expect(() => billableQuantity("per_day", new Date("2026-07-02"), new Date("2026-07-01"), NY)).toThrow();
  });

  it("estimates per pet in integer cents", () => {
    const e = estimateReservation({
      unit: "per_night", unitPriceCents: 5499, petCount: 2, timeZone: NY,
      startsAt: new Date("2026-07-01T14:00:00-04:00"), endsAt: new Date("2026-07-04T11:00:00-04:00"),
    });
    expect(e).toEqual({ quantity: 3, petCount: 2, unitPriceCents: 5499, totalCents: 32994 });
  });
});
