import { describe, expect, it } from "vitest";
import { DEFAULT_BILLING_RULES, priceStay, type BillingRules, type PricedService } from "./stay-pricing";

const TZ = "America/New_York";
const boarding: PricedService = { id: "b", name: "Boarding", category: "boarding", priceUnit: "per_night", priceCents: 5500 };
const full: PricedService = { id: "f", name: "Daycare — Full Day", category: "daycare", priceUnit: "per_day", priceCents: 3800 };
const half: PricedService = { id: "h", name: "Daycare — Half Day", category: "daycare", priceUnit: "per_day", priceCents: 2600 };
const groom: PricedService = { id: "g", name: "Full Groom", category: "grooming", priceUnit: "per_visit", priceCents: 8500 };
const rules = (r: Partial<BillingRules> = {}): BillingRules => ({ ...DEFAULT_BILLING_RULES, daycareFullServiceId: "f", daycareHalfServiceId: "h", ...r });
// Fri 2026-12-04 … Sun 2026-12-06, New York (UTC-5).
const at = (d: string, t: string) => new Date(`2026-12-${d}T${t}:00-05:00`);
const price = (r: Partial<BillingRules>, service: PricedService, from: Date, to: Date, petCount = 1) =>
  priceStay({ rules: rules(r), service, daycareFull: full, daycareHalf: half, startsAt: from, endsAt: to, petCount, timeZone: TZ });
const summary = (p: ReturnType<typeof price>) => p.lines.map((l) => [l.kind, l.units, l.amountCents]);

describe("boarding per night (daytime included)", () => {
  it("charges nights only, whatever the hours", () => {
    const p = price({}, boarding, at("04", "14:00"), at("06", "17:00"));
    expect(summary(p)).toEqual([["stay", 2, 11000]]);
    expect(p.lines[0]!.description).toBe("Boarding (2 nights)");
  });
});

describe("boarding per night plus daycare", () => {
  const r = { boardingMode: "nights_plus_daycare" as const };
  it("adds a half or full day of daycare for each day's daytime hours", () => {
    // Fri 2–7 PM = 5h (half), Sat all day (full), Sun 7–11 AM = 4h (half).
    const p = price(r, boarding, at("04", "14:00"), at("06", "11:00"));
    expect(summary(p)).toEqual([["stay", 2, 11000], ["daycare_full", 1, 3800], ["daycare_half", 2, 5200]]);
    expect(p.lines[1]).toMatchObject({ description: "Daycare — Full Day during stay (1 day)", dates: ["2026-12-05"] });
    expect(p.lines[2]!.dates).toEqual(["2026-12-04", "2026-12-06"]);
    expect(p.totalCents).toBe(20000);
  });
  it("doesn't charge daytime minutes within the grace period", () => {
    const p = price(r, boarding, at("04", "18:45"), at("05", "07:20"));
    expect(summary(p)).toEqual([["stay", 1, 5500]]);
  });
  it("uses the configured daytime window", () => {
    const p = price({ ...r, daytimeStart: "08:00", daytimeEnd: "18:00" }, boarding, at("04", "14:00"), at("05", "09:00"));
    // Fri 2–6 PM = 4h (half); Sat 8–9 AM = 1h (half).
    expect(summary(p)).toEqual([["stay", 1, 5500], ["daycare_half", 2, 5200]]);
  });
});

describe("boarding per 24 hours", () => {
  const r = { boardingMode: "per_24_hours" as const };
  it("charges at least one period", () => {
    expect(summary(price(r, boarding, at("04", "14:00"), at("05", "09:00")))).toEqual([["stay", 1, 5500]]);
  });
  it("allows the grace period after the last full 24 hours", () => {
    expect(summary(price(r, boarding, at("04", "14:00"), at("06", "14:20")))).toEqual([["stay", 2, 11000]]);
  });
  it("charges extra time as daycare (half or full day) by default", () => {
    expect(summary(price(r, boarding, at("04", "14:00"), at("06", "17:00")))).toEqual([["stay", 2, 11000], ["daycare_half", 1, 2600]]);
    const long = price(r, boarding, at("04", "08:00"), at("06", "17:00"));
    expect(summary(long)).toEqual([["stay", 2, 11000], ["daycare_full", 1, 3800]]);
    expect(long.lines[1]!.description).toBe("Daycare — Full Day after the last 24 hours (1 day)");
  });
  it("or as another 24-hour period", () => {
    const p = price({ ...r, boardingExtraTime: "extra_night" }, boarding, at("04", "14:00"), at("06", "17:00"));
    expect(summary(p)).toEqual([["stay", 3, 16500]]);
    expect(p.lines[0]!.description).toBe("Boarding (3 24-hour periods)");
  });
});

describe("daycare half and full days", () => {
  it("charges a half day up to the limit plus grace, and a full day after", () => {
    expect(summary(price({}, full, at("07", "07:30"), at("07", "11:30")))).toEqual([["daycare_half", 1, 2600]]);
    expect(summary(price({}, full, at("07", "07:30"), at("07", "13:00")))).toEqual([["daycare_half", 1, 2600]]); // 5h30
    expect(summary(price({}, full, at("07", "07:30"), at("07", "13:01")))).toEqual([["daycare_full", 1, 3800]]);
    expect(summary(price({ halfDayMaxHours: 4, gracePeriodMinutes: 0 }, full, at("07", "07:30"), at("07", "11:45")))).toEqual([["daycare_full", 1, 3800]]);
  });
  it("keeps the booked service's locked-in price and upgrades a long half day", () => {
    const lockedFull = { ...full, priceCents: 3500 };
    expect(summary(price({}, lockedFull, at("07", "07:30"), at("07", "18:00")))).toEqual([["daycare_full", 1, 3500]]);
    expect(summary(price({}, { ...half, priceCents: 2400 }, at("07", "08:00"), at("07", "17:00")))).toEqual([["daycare_full", 1, 3800]]);
  });
  it("without a half-day service, short days are full days", () => {
    const p = priceStay({ rules: rules({ daycareHalfServiceId: null }), service: full, daycareFull: full, daycareHalf: null,
      startsAt: at("07", "08:00"), endsAt: at("07", "10:00"), petCount: 1, timeZone: TZ });
    expect(summary(p)).toEqual([["daycare_full", 1, 3800]]);
  });
  it("leaves other daycare services and setups without daycare services as they were", () => {
    const puppy = { ...full, id: "p", name: "Puppy Daycare" };
    expect(summary(price({}, puppy, at("07", "08:00"), at("07", "10:00")))).toEqual([["stay", 1, 3800]]);
    const p = priceStay({ rules: DEFAULT_BILLING_RULES, service: full, startsAt: at("07", "08:00"), endsAt: at("07", "10:00"), petCount: 1, timeZone: TZ });
    expect(summary(p)).toEqual([["stay", 1, 3800]]);
    expect(p.lines[0]!.dates).toEqual(["2026-12-07"]);
  });
});

describe("additional pets", () => {
  it("discounts boarding and daycare for each pet after the first, not grooming", () => {
    const p = price({ additionalPetDiscountBps: 1000 }, boarding, at("04", "14:00"), at("06", "11:00"), 2);
    expect(p.lines[0]).toMatchObject({ units: 2, petCount: 2, discountCents: 1100, amountCents: 20900 });
    expect(price({ additionalPetDiscountBps: 1000 }, groom, at("07", "10:00"), at("07", "12:00"), 2).lines[0]).toMatchObject({ discountCents: 0, amountCents: 17000 });
    expect(price({ additionalPetDiscountBps: 1000 }, full, at("07", "08:00"), at("07", "17:00"), 3).lines[0]).toMatchObject({ discountCents: 760, amountCents: 10640 });
  });
});
