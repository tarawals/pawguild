/**
 * Business hours and closures. A location with no weekly hours set has no hours restriction
 * (older installs, or businesses that don't want one). Once any hours are set, a weekday
 * without hours is closed. Closure dates always apply.
 *
 * Only drop-off and pick-up are checked: a boarding stay can span a closed day, since the pets
 * are still cared for; what matters is that someone is at the desk at each end.
 */
export const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface OpeningHours { weekday: number; opensAt: string; closesAt: string }
export interface Closure { closedOn: string; reason?: string | null }

export type HoursProblem =
  | { kind: "closure"; date: string; time: string; reason: string | null }
  | { kind: "closed_day"; date: string; time: string; weekday: number }
  | { kind: "outside_hours"; date: string; time: string; weekday: number; opensAt: string; closesAt: string };

/** The local calendar date, weekday (0 = Sunday) and HH:MM time of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { date: string; weekday: number; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { date, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay(), time: `${parts.hour}:${parts.minute}` };
}

/** "07:00:00" (from the database) or "07:00" → "07:00". */
export const hhmm = (t: string) => t.slice(0, 5);

/** Why a location isn't open at this moment, or null when it is (opening and closing times included). */
export function hoursProblem(at: Date, timeZone: string, hours: readonly OpeningHours[], closures: readonly Closure[]): HoursProblem | null {
  const { date, weekday, time } = localParts(at, timeZone);
  const closure = closures.find((c) => c.closedOn === date);
  if (closure) return { kind: "closure", date, time, reason: closure.reason ?? null };
  if (hours.length === 0) return null;
  const day = hours.find((h) => h.weekday === weekday);
  if (!day) return { kind: "closed_day", date, time, weekday };
  const opensAt = hhmm(day.opensAt), closesAt = hhmm(day.closesAt);
  if (time < opensAt || time > closesAt) return { kind: "outside_hours", date, time, weekday, opensAt, closesAt };
  return null;
}

/** "07:00" → "7:00 AM". */
export function formatTimeOfDay(t: string): string {
  const [h, m] = hhmm(t).split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function formatDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** A sentence for staff, e.g. "Drop-off on Sun, Dec 6 at 6:30 AM is before opening (7:00 AM)". */
export function describeHoursProblem(what: string, p: HoursProblem): string {
  const when = `${what} on ${formatDay(p.date)} at ${formatTimeOfDay(p.time)}`;
  switch (p.kind) {
    case "closure": return `${when}: the location is closed that day${p.reason ? ` (${p.reason})` : ""}`;
    case "closed_day": return `${when}: the location is closed on ${WEEKDAY_LABELS[p.weekday]}s`;
    case "outside_hours": return `${when} is ${p.time < p.opensAt ? "before opening" : "after closing"} (open ${formatTimeOfDay(p.opensAt)}–${formatTimeOfDay(p.closesAt)})`;
  }
}

/** A compact weekly summary, e.g. "Mon–Fri 7:00 AM–7:00 PM · Sat 8:00 AM–5:00 PM · Sun closed". */
export function summarizeHours(hours: readonly OpeningHours[]): string {
  if (hours.length === 0) return "No hours set";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const label = (w: number) => {
    const h = hours.find((x) => x.weekday === w);
    return h ? `${formatTimeOfDay(h.opensAt)}–${formatTimeOfDay(h.closesAt)}` : "closed";
  };
  const groups: { from: number; to: number; text: string }[] = [];
  for (const w of order) {
    const text = label(w);
    const last = groups[groups.length - 1];
    if (last && last.text === text) last.to = w; else groups.push({ from: w, to: w, text });
  }
  const short = (w: number) => WEEKDAY_LABELS[w]!.slice(0, 3);
  return groups.map((g) => `${short(g.from)}${g.from === g.to ? "" : `–${short(g.to)}`} ${g.text}`).join(" · ");
}

/** The instant at which a location's wall clock shows `date` `time` (HH:MM), across DST changes. */
export function zonedDateTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm(time).split(":").map(Number) as [number, number];
  const naive = Date.UTC(y, m - 1, d, h, mi);
  const offset = (at: number) => {
    const p = localParts(new Date(at), timeZone);
    const [py, pm, pd] = p.date.split("-").map(Number) as [number, number, number];
    const [ph, pmi] = p.time.split(":").map(Number) as [number, number];
    return Date.UTC(py, pm - 1, pd, ph, pmi) - Math.floor(at / 60_000) * 60_000;
  };
  let t = naive - offset(naive);
  t = naive - offset(t);
  return new Date(t);
}

/** Add whole calendar days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Every date from `first` to `last` (inclusive) that falls on one of the weekdays (0 = Sunday). */
export function seriesDates(first: string, last: string, weekdays: readonly number[]): string[] {
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    if (weekdays.includes(new Date(`${d}T12:00:00Z`).getUTCDay())) out.push(d);
  }
  return out;
}
