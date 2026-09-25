/**
 * Capacity periods. Daycare capacity is counted per local calendar day; boarding capacity per
 * local night. These functions define which periods a stay occupies; the API applies the same
 * rules in SQL (see apps/api/src/lib/capacity.ts) and tests keep them in agreement.
 */
import { calendarDate } from "./pricing";

export const CAPACITY_CATEGORIES = ["daycare", "boarding"] as const;
export type CapacityCategory = (typeof CAPACITY_CATEGORIES)[number];

export const RESOURCE_KINDS = ["kennel", "suite", "room", "run", "play_area", "grooming_station", "other"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  kennel: "Kennel", suite: "Suite", room: "Room", run: "Run", play_area: "Play area",
  grooming_station: "Grooming station", other: "Other",
};

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Local calendar days a daycare stay touches (inclusive). */
export function daysCovered(startsAt: Date, endsAt: Date, timeZone: string): string[] {
  const first = calendarDate(startsAt, timeZone);
  const last = calendarDate(endsAt, timeZone);
  const out: string[] = [];
  for (let d = first; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Local nights a boarding stay occupies, named by the date the night starts. A stay from Jul 1 to
 * Jul 4 occupies the nights of Jul 1, 2 and 3. A same-day stay still occupies that night.
 */
export function nightsCovered(startsAt: Date, endsAt: Date, timeZone: string): string[] {
  const first = calendarDate(startsAt, timeZone);
  const end = calendarDate(endsAt, timeZone);
  const stop = end > first ? end : addDays(first, 1);
  const out: string[] = [];
  for (let d = first; d < stop; d = addDays(d, 1)) out.push(d);
  return out;
}

export function periodsCovered(category: CapacityCategory, startsAt: Date, endsAt: Date, timeZone: string): string[] {
  return category === "daycare" ? daysCovered(startsAt, endsAt, timeZone) : nightsCovered(startsAt, endsAt, timeZone);
}

export function isCapacityCategory(value: string): value is CapacityCategory {
  return (CAPACITY_CATEGORIES as readonly string[]).includes(value);
}
