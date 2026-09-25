/**
 * Invoice arithmetic. All amounts are integer cents. Tax is calculated once per invoice on the
 * sum of taxable line amounts (after each line's discount), rounded half away from zero.
 * The database recomputes the same totals when an invoice is issued (migration 0006).
 */
import { assertCents, percentOf, type Cents } from "./money";

export interface InvoiceLineAmounts {
  quantity: number;
  unitPriceCents: Cents;
  discountCents: Cents;
  taxable: boolean;
}

export interface InvoiceTotals {
  subtotalCents: Cents;   // before discounts
  discountCents: Cents;
  taxableCents: Cents;    // after discounts, taxable lines only
  taxCents: Cents;
  totalCents: Cents;
}

export function lineGross(line: InvoiceLineAmounts): Cents {
  return assertCents(line.quantity * line.unitPriceCents);
}

export function lineAmount(line: InvoiceLineAmounts): Cents {
  const gross = lineGross(line);
  if (line.discountCents < 0 || line.discountCents > gross) throw new RangeError("Discount must be between 0 and the line amount");
  return assertCents(gross - line.discountCents);
}

export function invoiceTotals(lines: readonly InvoiceLineAmounts[], taxRateBps: number): InvoiceTotals {
  if (!Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 10_000) throw new RangeError("Tax rate must be 0–100%");
  let subtotal = 0, discount = 0, taxable = 0;
  for (const l of lines) {
    subtotal += lineGross(l);
    discount += l.discountCents;
    if (l.taxable) taxable += lineAmount(l);
  }
  const tax = percentOf(taxable, taxRateBps);
  return {
    subtotalCents: assertCents(subtotal),
    discountCents: assertCents(discount),
    taxableCents: assertCents(taxable),
    taxCents: tax,
    totalCents: assertCents(subtotal - discount + tax),
  };
}

/** "8.25" (percent) → 825 basis points, without float math. */
export function parsePercentToBps(input: string): number {
  const m = /^\s*(\d{1,3})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(input);
  if (!m) throw new RangeError(`Enter a percentage like 7 or 8.25`);
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps > 10_000) throw new RangeError("A percentage can't be over 100");
  return bps;
}

export function formatBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

export const PAYMENT_METHODS = ["card", "cash", "check", "other"] as const;
export const PAYMENT_METHOD_LABELS: Record<(typeof PAYMENT_METHODS)[number], string> = {
  card: "Card", cash: "Cash", check: "Check", other: "Other",
};

/**
 * What the customer still owes on an issued invoice. Negative means they overpaid, and the
 * difference must be refunded or moved to account credit.
 */
export function invoiceBalance(args: { totalCents: Cents; creditNotesCents: Cents; paymentsCents: Cents; refundsCents: Cents }): Cents {
  return assertCents(args.totalCents - args.creditNotesCents - (args.paymentsCents - args.refundsCents));
}

export const REFUND_METHOD_LABELS = { ...PAYMENT_METHOD_LABELS, account_credit: "Account credit" } as const;
