/**
 * How a stay turns into charges, under the business's billing rules. Used for the estimate shown
 * while booking, the estimate on a reservation and the lines of the invoice drafted from it, so
 * all three always agree. Amounts are integer cents.
 */
import { addDays, zonedDateTime } from "./hours";
import { assertCents, percentOf, type Cents } from "./money";
import { billableQuantity, calendarDate, type PriceUnit } from "./pricing";

export const BOARDING_MODES = ["nights", "nights_plus_daycare", "per_24_hours"] as const;
export type BoardingMode = (typeof BOARDING_MODES)[number];
export const BOARDING_MODE_LABELS: Record<BoardingMode, string> = {
  nights: "Per night (daytime care included)",
  nights_plus_daycare: "Per night, plus daycare for daytime hours",
  per_24_hours: "Per 24 hours from drop-off",
};
export const EXTRA_TIME_RULES = ["extra_night", "daycare"] as const;
export type ExtraTimeRule = (typeof EXTRA_TIME_RULES)[number];

export interface BillingRules {
  boardingMode: BoardingMode;
  /** Per-24-hours boarding: what time past the last full 24 hours (after the grace period) costs. */
  boardingExtraTime: ExtraTimeRule;
  /** Daycare up to this many hours (plus the grace period) is a half day; longer is a full day. */
  halfDayMaxHours: number;
  /** Minutes of lateness allowed before extra time is charged. */
  gracePeriodMinutes: number;
  /** "Daytime" used to count daycare during boarding (HH:MM). */
  daytimeStart: string;
  daytimeEnd: string;
  /** The services whose prices are used for full and half days of daycare. */
  daycareFullServiceId: string | null;
  daycareHalfServiceId: string | null;
  /** Discount on boarding and daycare for each pet after the first, in basis points (1000 = 10%). */
  additionalPetDiscountBps: number;
}

export const DEFAULT_BILLING_RULES: BillingRules = {
  boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30,
  daytimeStart: "07:00", daytimeEnd: "19:00", daycareFullServiceId: null, daycareHalfServiceId: null, additionalPetDiscountBps: 0,
};

export interface PricedService { id: string; name: string; category: string; priceUnit: PriceUnit; priceCents: Cents }

export type StayLineKind = "stay" | "daycare_full" | "daycare_half" | "extra_night";
export interface StayLine {
  kind: StayLineKind;
  serviceId: string;
  /** e.g. "Boarding — Standard Suite (2 nights)". */
  description: string;
  /** The parts of the description, so invoices can add pet names: "Boarding — Standard Suite", "2 nights". */
  label: string;
  unitsText: string;
  /** Units for one pet (nights, days, periods). */
  units: number;
  /** For daycare lines: the local date of each unit, so packages can check expiry. */
  dates?: string[];
  petCount: number;
  unitPriceCents: Cents;
  discountCents: Cents;
  amountCents: Cents;
}

export interface StayPrice { lines: StayLine[]; totalCents: Cents }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/** Minutes the stay overlaps a window. */
function overlapMinutes(startsAt: Date, endsAt: Date, from: Date, to: Date): number {
  const s = Math.max(startsAt.getTime(), from.getTime()), e = Math.min(endsAt.getTime(), to.getTime());
  return Math.max(0, Math.round((e - s) / 60_000));
}

/** Half or full day for this many minutes of daycare (null when too short to charge). */
export function daycareDayKind(minutes: number, rules: BillingRules): "daycare_half" | "daycare_full" | null {
  if (minutes <= 0) return null;
  return minutes <= rules.halfDayMaxHours * 60 + rules.gracePeriodMinutes ? "daycare_half" : "daycare_full";
}

export function priceStay(args: {
  rules: BillingRules;
  /** The booked service, with the price locked in at booking. */
  service: PricedService;
  /** Current daycare services named in the rules (used for daycare charges). */
  daycareFull?: PricedService | null;
  daycareHalf?: PricedService | null;
  startsAt: Date; endsAt: Date; petCount: number; timeZone: string;
}): StayPrice {
  const { rules, service, startsAt, endsAt, petCount, timeZone } = args;
  if (endsAt <= startsAt) throw new RangeError("End must be after start");
  if (!Number.isInteger(petCount) || petCount < 1) throw new RangeError("petCount must be at least 1");
  assertCents(service.priceCents);
  const lines: StayLine[] = [];
  const discounted = service.category === "boarding" || service.category === "daycare";
  const add = (kind: StayLineKind, svc: PricedService, label: string, unitsText: string, units: number, dates?: string[]) => {
    if (units <= 0) return;
    const description = `${label} (${unitsText})`;
    const gross = svc.priceCents * units * petCount;
    const discountCents = discounted && petCount > 1 && rules.additionalPetDiscountBps > 0
      ? percentOf(svc.priceCents * units * (petCount - 1), rules.additionalPetDiscountBps) : 0;
    lines.push({ kind, serviceId: svc.id, description, label, unitsText, units, dates, petCount, unitPriceCents: svc.priceCents, discountCents, amountCents: assertCents(gross - discountCents) });
  };
  // Daycare charged as half or full days, one per date.
  // Without a half-day service, short days are charged as full days.
  const addDaycareDays = (days: { date: string; kind: "daycare_half" | "daycare_full" }[], suffix: string,
    full = args.daycareFull ?? null, half = args.daycareHalf ?? null) => {
    const charged = days.map((d) => ({ date: d.date, kind: d.kind === "daycare_half" && half ? "daycare_half" as const : "daycare_full" as const }));
    for (const kind of ["daycare_full", "daycare_half"] as const) {
      const svc = kind === "daycare_full" ? full : half;
      const dates = charged.filter((d) => d.kind === kind).map((d) => d.date);
      if (!svc || dates.length === 0) continue;
      add(kind, svc, `${svc.name}${suffix}`, plural(dates.length, "day"), dates.length, dates);
    }
  };

  const isBoarding = service.category === "boarding" && service.priceUnit === "per_night";
  if (isBoarding && rules.boardingMode === "per_24_hours") {
    const minutes = minutesBetween(startsAt, endsAt);
    let periods = Math.floor(minutes / 1440);
    const extra = minutes - periods * 1440;
    if (periods === 0) periods = 1;
    else if (extra > rules.gracePeriodMinutes && rules.boardingExtraTime === "extra_night") periods += 1;
    add("stay", service, service.name, plural(periods, "24-hour period"), periods);
    if (minutes >= 1440 && extra > rules.gracePeriodMinutes && rules.boardingExtraTime === "daycare") {
      const kind = extra <= rules.halfDayMaxHours * 60 ? "daycare_half" : "daycare_full";
      addDaycareDays([{ date: calendarDate(endsAt, timeZone), kind }], " after the last 24 hours");
    }
  } else if (isBoarding) {
    const nights = billableQuantity("per_night", startsAt, endsAt, timeZone);
    add("stay", service, service.name, plural(nights, "night"), nights);
    if (rules.boardingMode === "nights_plus_daycare") {
      const days: { date: string; kind: "daycare_half" | "daycare_full" }[] = [];
      const last = calendarDate(endsAt, timeZone);
      for (let d = calendarDate(startsAt, timeZone); d <= last; d = addDays(d, 1)) {
        const mins = overlapMinutes(startsAt, endsAt, zonedDateTime(d, rules.daytimeStart, timeZone), zonedDateTime(d, rules.daytimeEnd, timeZone));
        // Time within the grace period (e.g. a pick-up a few minutes after the day starts) isn't charged.
        const kind = mins > rules.gracePeriodMinutes ? daycareDayKind(mins, rules) : null;
        if (kind) days.push({ date: d, kind });
      }
      addDaycareDays(days, " during stay");
    }
  } else if (service.category === "daycare" && service.priceUnit === "per_day"
    && (service.id === rules.daycareFullServiceId || service.id === rules.daycareHalfServiceId) && args.daycareFull) {
    // Half or full day decided by time on site each day, whichever of the two was booked.
    const days: { date: string; kind: "daycare_half" | "daycare_full" }[] = [];
    const last = calendarDate(endsAt, timeZone);
    for (let d = calendarDate(startsAt, timeZone); d <= last; d = addDays(d, 1)) {
      const mins = overlapMinutes(startsAt, endsAt, zonedDateTime(d, "00:00", timeZone), zonedDateTime(addDays(d, 1), "00:00", timeZone));
      const kind = daycareDayKind(mins, rules);
      if (kind) days.push({ date: d, kind });
    }
    // The booked service keeps the price locked in at booking; the other uses today's price.
    addDaycareDays(days, "",
      service.id === rules.daycareFullServiceId ? service : args.daycareFull,
      service.id === rules.daycareHalfServiceId ? service : args.daycareHalf);
  } else {
    const units = billableQuantity(service.priceUnit, startsAt, endsAt, timeZone);
    const word = service.priceUnit === "per_night" ? "night" : service.priceUnit === "per_day" ? "day" : "visit";
    const dates = service.category === "daycare" && service.priceUnit === "per_day"
      ? Array.from({ length: units }, (_, i) => addDays(calendarDate(startsAt, timeZone), i)) : undefined;
    add("stay", service, service.name, plural(units, word), units, dates);
  }
  return { lines, totalCents: assertCents(lines.reduce((n, l) => n + l.amountCents, 0)) };
}

/** A sentence for owners: how a sample stay would be charged under these rules. */
export function describeStayPrice(price: StayPrice, formatMoney: (c: Cents) => string): string {
  return price.lines.map((l) => `${l.description}${l.petCount > 1 ? ` × ${l.petCount} pets` : ""}: ${formatMoney(l.amountCents)}`).join("; ")
    + ` — total ${formatMoney(price.totalCents)}`;
}
