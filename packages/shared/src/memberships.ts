/**
 * Membership billing periods. A membership bills on its sign-up date and then on the same day of
 * each month; when a month is shorter, it bills on that month's last day (so a membership started
 * on Jan 31 bills Feb 28, then Mar 31). Each period runs until the day before the next bill.
 */
import { addDays } from "./hours";

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** The start of the k-th period (k = 0 is the sign-up date). */
export function membershipPeriodStart(startedOn: string, k: number): string {
  const [y, m, d] = startedOn.split("-").map(Number) as [number, number, number];
  const total = (m - 1) + k;
  const year = y + Math.floor(total / 12), month0 = ((total % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(year, month0));
  return `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function membershipPeriod(startedOn: string, k: number): { start: string; end: string } {
  return { start: membershipPeriodStart(startedOn, k), end: addDays(membershipPeriodStart(startedOn, k + 1), -1) };
}

/**
 * Periods that should have been billed by `today` but haven't (k from `billed` on), stopping at
 * the membership's end date.
 */
export function duePeriods(startedOn: string, billed: number, today: string, endsOn: string | null): { k: number; start: string; end: string }[] {
  const out: { k: number; start: string; end: string }[] = [];
  for (let k = billed; k < billed + 60; k++) {
    const p = membershipPeriod(startedOn, k);
    if (p.start > today || (endsOn && p.start > endsOn)) break;
    out.push({ k, ...p });
  }
  return out;
}
