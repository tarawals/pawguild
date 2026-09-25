const GRAMS_PER_LB = 453.59237;

export function lbsToGrams(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const lbs = Number(trimmed);
  if (!Number.isFinite(lbs) || lbs <= 0) return NaN;
  return Math.round(lbs * GRAMS_PER_LB);
}

export function gramsToLbs(grams: number | null): string {
  return grams == null ? "" : (grams / GRAMS_PER_LB).toFixed(1);
}

/** Whole days from today (local) until an ISO date; negative when in the past. */
export function daysUntil(isoDate: string, today = new Date()): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((target - now) / 86400_000);
}

export function formatDate(isoDate: string | null): string {
  if (!isoDate) return "—";
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
