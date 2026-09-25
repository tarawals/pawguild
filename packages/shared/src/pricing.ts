/** Reservation pricing. All amounts are integer cents; see money.ts. */
import { assertCents, type Cents } from "./money";

export const SERVICE_CATEGORIES = ["daycare", "boarding", "grooming", "training", "add_on", "other"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];
export const SERVICE_CATEGORY_LABELS: Record<ServiceCategory, string> = {
  daycare: "Daycare", boarding: "Boarding", grooming: "Grooming", training: "Training", add_on: "Add-on", other: "Other",
};

export const PRICE_UNITS = ["per_day", "per_night", "per_visit"] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];
export const PRICE_UNIT_LABELS: Record<PriceUnit, string> = {
  per_day: "per day", per_night: "per night", per_visit: "per visit",
};

/** Calendar date (YYYY-MM-DD) of an instant in an IANA time zone. */
export function calendarDate(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

function dateDiffDays(a: string, b: string): number {
  const toUtc = (d: string) => {
    const [y, m, day] = d.split("-").map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400_000);
}

/**
 * Billable quantity for a stay, measured in the business's local calendar:
 *  - per_night: nights between check-in and check-out dates (minimum 1)
 *  - per_day:   calendar days touched, inclusive (a same-day stay is 1)
 *  - per_visit: always 1
 */
export function billableQuantity(unit: PriceUnit, startsAt: Date, endsAt: Date, timeZone: string): number {
  if (endsAt <= startsAt) throw new RangeError("End must be after start");
  if (unit === "per_visit") return 1;
  const days = dateDiffDays(calendarDate(startsAt, timeZone), calendarDate(endsAt, timeZone));
  return unit === "per_night" ? Math.max(1, days) : days + 1;
}

export interface ReservationEstimate {
  quantity: number;
  petCount: number;
  unitPriceCents: Cents;
  totalCents: Cents;
}

/** Estimated charge before taxes, discounts and add-ons (those arrive with billing). */
export function estimateReservation(args: {
  unit: PriceUnit; unitPriceCents: Cents; startsAt: Date; endsAt: Date; petCount: number; timeZone: string;
}): ReservationEstimate {
  assertCents(args.unitPriceCents);
  if (!Number.isInteger(args.petCount) || args.petCount < 1) throw new RangeError("petCount must be at least 1");
  const quantity = billableQuantity(args.unit, args.startsAt, args.endsAt, args.timeZone);
  return {
    quantity,
    petCount: args.petCount,
    unitPriceCents: args.unitPriceCents,
    totalCents: assertCents(args.unitPriceCents * quantity * args.petCount),
  };
}
