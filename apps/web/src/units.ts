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

/** Value for <input type="datetime-local"> from an ISO instant, in the browser's time zone. */
export function toLocalInput(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO instant from an <input type="datetime-local"> value (interpreted in the browser's time zone). */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Jul 1, 2:00 PM – Jul 4, 11:00 AM" (or a single date when same day). */
export function formatRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: s.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return s.toDateString() === e.toDateString()
    ? `${day(s)}, ${time(s)} – ${time(e)}`
    : `${day(s)}, ${time(s)} – ${day(e)}, ${time(e)}`;
}
