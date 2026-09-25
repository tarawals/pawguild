import { describe, expect, it } from "vitest";
import { daysUntil, gramsToLbs, lbsToGrams } from "./units";

describe("units", () => {
  it("round-trips pounds through integer grams", () => {
    expect(lbsToGrams("45")).toBe(20412);
    expect(gramsToLbs(20412)).toBe("45.0");
    expect(lbsToGrams("")).toBeNull();
    expect(lbsToGrams("abc")).toBeNaN();
    expect(lbsToGrams("-3")).toBeNaN();
  });
  it("counts days until a date", () => {
    const today = new Date(2026, 8, 25);
    expect(daysUntil("2026-09-25", today)).toBe(0);
    expect(daysUntil("2026-10-05", today)).toBe(10);
    expect(daysUntil("2026-09-20", today)).toBe(-5);
  });
});
