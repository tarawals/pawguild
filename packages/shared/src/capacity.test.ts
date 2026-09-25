import { describe, expect, it } from "vitest";
import { daysCovered, nightsCovered } from "./capacity";

const NY = "America/New_York";
const d = (s: string) => new Date(s);

describe("capacity periods", () => {
  it("counts boarding nights by the date each night starts", () => {
    expect(nightsCovered(d("2026-07-01T14:00:00-04:00"), d("2026-07-04T11:00:00-04:00"), NY))
      .toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });
  it("treats a same-day boarding stay as one night", () => {
    expect(nightsCovered(d("2026-07-01T08:00:00-04:00"), d("2026-07-01T18:00:00-04:00"), NY)).toEqual(["2026-07-01"]);
  });
  it("counts daycare days inclusively", () => {
    expect(daysCovered(d("2026-07-01T07:30:00-04:00"), d("2026-07-01T18:00:00-04:00"), NY)).toEqual(["2026-07-01"]);
    expect(daysCovered(d("2026-07-30T07:30:00-04:00"), d("2026-08-02T18:00:00-04:00"), NY))
      .toEqual(["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"]);
  });
  it("uses the business's local date, not UTC", () => {
    // 11pm in New York on Jul 1 is already Jul 2 in UTC.
    expect(daysCovered(d("2026-07-01T23:00:00-04:00"), d("2026-07-01T23:30:00-04:00"), NY)).toEqual(["2026-07-01"]);
  });
});
