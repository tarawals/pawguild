import { describe, expect, it } from "vitest";
import { formatBps, invoiceTotals, lineAmount, parsePercentToBps } from "./invoice";

describe("invoice totals", () => {
  it("taxes only taxable lines, after their discounts, once per invoice", () => {
    const t = invoiceTotals([
      { quantity: 3, unitPriceCents: 5500, discountCents: 0, taxable: false },   // boarding 3 nights, not taxed
      { quantity: 1, unitPriceCents: 8500, discountCents: 850, taxable: true },  // groom, 10% off, taxed
      { quantity: 2, unitPriceCents: 1500, discountCents: 0, taxable: true },    // 2 nail trims, taxed
    ], 825);
    expect(t).toEqual({
      subtotalCents: 16500 + 8500 + 3000,
      discountCents: 850,
      taxableCents: 7650 + 3000,
      taxCents: 879, // 8.25% of $106.50 = $8.78625 → $8.79
      totalCents: 28000 - 850 + 879,
    });
  });

  it("rounds tax half away from zero and handles zero rate and empty invoices", () => {
    expect(invoiceTotals([{ quantity: 1, unitPriceCents: 1000, discountCents: 0, taxable: true }], 825).taxCents).toBe(83);
    expect(invoiceTotals([{ quantity: 1, unitPriceCents: 1000, discountCents: 0, taxable: true }], 0).taxCents).toBe(0);
    expect(invoiceTotals([], 825).totalCents).toBe(0);
  });

  it("rejects discounts larger than the line or negative", () => {
    expect(() => lineAmount({ quantity: 1, unitPriceCents: 1000, discountCents: 1001, taxable: false })).toThrow();
    expect(() => lineAmount({ quantity: 1, unitPriceCents: 1000, discountCents: -1, taxable: false })).toThrow();
  });
});

describe("percentages", () => {
  it("parses and formats basis points exactly", () => {
    expect(parsePercentToBps("8.25")).toBe(825);
    expect(parsePercentToBps("7")).toBe(700);
    expect(parsePercentToBps("6.5%")).toBe(650);
    expect(parsePercentToBps("0")).toBe(0);
    expect(() => parsePercentToBps("8.255")).toThrow();
    expect(() => parsePercentToBps("abc")).toThrow();
    expect(() => parsePercentToBps("101")).toThrow();
    expect(formatBps(825)).toBe("8.25%");
    expect(formatBps(650)).toBe("6.5%");
    expect(formatBps(700)).toBe("7%");
  });
});
