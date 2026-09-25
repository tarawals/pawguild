import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney, percentOf, sumCents } from "./money";

describe("money", () => {
  it("parses decimal strings to integer cents without float error", () => {
    expect(parseMoney("12.34")).toBe(1234);
    expect(parseMoney("0.1")).toBe(10);
    expect(parseMoney("19.99")).toBe(1999);
    expect(parseMoney("-3.07")).toBe(-307);
    expect(parseMoney("5")).toBe(500);
  });
  it("rejects invalid amounts", () => {
    for (const bad of ["", "1.234", "abc", "1,000", "$5"]) expect(() => parseMoney(bad)).toThrow();
  });
  it("formats cents", () => {
    expect(formatMoney(123456)).toBe("$1,234.56");
    expect(formatMoney(-500)).toBe("-$5.00");
    expect(formatMoney(0)).toBe("$0.00");
  });
  it("sums and rejects non-integers", () => {
    expect(sumCents([10, 20, 30])).toBe(60);
    expect(() => sumCents([0.1, 0.2])).toThrow();
  });
  it("computes percentages in basis points with half-away-from-zero rounding", () => {
    expect(percentOf(1000, 825)).toBe(83); // 8.25% of $10.00 = 82.5c -> 83c
    expect(percentOf(999, 1000)).toBe(100); // 99.9c -> 100c
    expect(percentOf(-1000, 825)).toBe(-83);
    expect(percentOf(1234, 0)).toBe(0);
  });
});
