import { describe, expect, it } from "vitest";
import { parseTimesOfDay } from "./care";

describe("parseTimesOfDay", () => {
  it("accepts 24-hour and am/pm times, sorted and de-duplicated", () => {
    expect(parseTimesOfDay("18:00, 8:00, 6:00 pm, 12:30am")).toEqual(["00:30", "08:00", "18:00"]);
    expect(parseTimesOfDay("")).toEqual([]);
  });
  it("rejects nonsense with a helpful message", () => {
    expect(() => parseTimesOfDay("breakfast")).toThrow(/isn't a time/);
    expect(() => parseTimesOfDay("25:00")).toThrow(/valid time/);
    expect(() => parseTimesOfDay("13:00 pm")).toThrow(/valid time/);
  });
});
