/**
 * Money is always an integer number of minor units (cents). Never use floats for money.
 * The database stores money as BIGINT cents; the API exchanges integer cents.
 */
export type Cents = number;

export function assertCents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Money must be an integer number of cents, got ${value}`);
  }
  return value;
}

/** Parse a user-entered decimal string such as "12.5" or "-3.07" into cents without float math. */
export function parseMoney(input: string): Cents {
  const match = /^\s*(-)?(\d+)(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) throw new RangeError(`Invalid money amount: "${input}"`);
  const [, sign, whole, frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return assertCents(sign ? -cents : cents);
}

export function formatMoney(cents: Cents, currency = "USD", locale = "en-US"): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  // Format via Intl using the exact decimal string so no float rounding is involved.
  const formatted = new Intl.NumberFormat(locale, { style: "currency", currency }).format(
    Number(`${whole}.${frac}`),
  );
  return negative ? `-${formatted.replace("-", "")}` : formatted;
}

export function sumCents(values: readonly Cents[]): Cents {
  return assertCents(values.reduce((a, b) => a + b, 0));
}

/**
 * Percentage of an amount expressed in basis points (1% = 100 bps), rounded half away from zero.
 * Used for tax and percentage discounts.
 */
export function percentOf(cents: Cents, basisPoints: number): Cents {
  assertCents(cents);
  if (!Number.isInteger(basisPoints)) throw new RangeError("basisPoints must be an integer");
  const product = cents * basisPoints;
  const q = Math.trunc(product / 10000);
  const r = Math.abs(product % 10000);
  const rounded = r * 2 >= 10000 ? q + Math.sign(product) : q;
  return assertCents(rounded);
}
