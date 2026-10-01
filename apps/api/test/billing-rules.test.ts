import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
const svc: Record<string, string> = {};
let customerId: string;
const pets: string[] = [];

// New York, December (UTC-5). Fri 2026-12-04 … Sun 2026-12-06.
const at = (d: string, t: string) => `2026-12-${d}T${t}:00-05:00`;
const rules = (r: object = {}) => ({
  boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30, daytimeStart: "07:00", daytimeEnd: "19:00",
  daycareFullServiceId: svc.full, daycareHalfServiceId: svc.half, additionalPetDiscountBps: 0, ...r,
});

/** Book, read the estimate, invoice it, and return both for comparison. */
async function bookAndInvoice(service: string, from: string, to: string, petIds: string[]) {
  const r = (await desk.post("/api/reservations", { customerId, locationId: org.locationId, serviceId: svc[service], petIds, startsAt: from, endsAt: to, status: "confirmed" })).json();
  const inv = (await desk.post(`/api/reservations/${r.id}/invoice`)).json();
  return {
    estimate: r.estimate as { totalCents: number; lines: { kind: string; units: number; amountCents: number }[] },
    lines: inv.lines.map((l: { description: string; quantity: number; unitPriceCents: number; discountCents: number }) => [l.description, l.quantity, l.unitPriceCents, l.discountCents]),
    subtotal: inv.lines.reduce((n: number, l: { amountCents: number }) => n + l.amountCents, 0),
  };
}

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "manager", "front_desk"]);
  owner = await login(ctx.app, org.users.owner!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  for (const [key, name, category, priceCents, priceUnit] of [
    ["boarding", "Boarding", "boarding", 5500, "per_night"], ["full", "Daycare — Full Day", "daycare", 3800, "per_day"],
    ["half", "Daycare — Half Day", "daycare", 2600, "per_day"], ["groom", "Groom", "grooming", 8500, "per_visit"],
  ] as const) svc[key] = (await owner.post("/api/services", { name, category, priceCents, priceUnit })).json().id;
  customerId = (await desk.post("/api/customers", { firstName: "Bill", lastName: "Rules" })).json().id;
  for (const name of ["Ace", "Bo", "Cy", "Di", "Ed", "Fi"]) pets.push((await desk.post("/api/pets", { customerId, name, species: "dog" })).json().id);
});
afterAll(async () => { await ctx.close(); });

describe("billing rules settings", () => {
  it("start with the defaults: per night, daytime included", async () => {
    expect((await desk.get("/api/settings/billing")).json()).toEqual({
      boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30, daytimeStart: "07:00", daytimeEnd: "19:00",
      daycareFullServiceId: null, daycareHalfServiceId: null, additionalPetDiscountBps: 0,
    });
  });

  it("only owners and administrators change them, and they're validated", async () => {
    expect((await manager.put("/api/settings/billing", rules())).statusCode).toBe(403);
    const paths = async (body: object) => (await owner.put("/api/settings/billing", body)).json().error.fields.map((f: { path: string }) => f.path);
    expect(await paths(rules({ boardingMode: "nights_plus_daycare", daycareFullServiceId: null }))).toEqual(["daycareFullServiceId"]);
    expect(await paths(rules({ daytimeStart: "19:00", daytimeEnd: "07:00" }))).toEqual(["daytimeEnd"]);
    expect(await paths(rules({ halfDayMaxHours: 4.2 }))).toEqual(["halfDayMaxHours"]);
    expect(await paths(rules({ daycareHalfServiceId: svc.full }))).toEqual(["daycareHalfServiceId"]);
    expect(await paths(rules({ daycareHalfServiceId: svc.groom }))).toEqual(["daycareHalfServiceId"]);
    const ok = await owner.put("/api/settings/billing", rules({ halfDayMaxHours: 4.5 }));
    expect(ok.json()).toMatchObject({ halfDayMaxHours: 4.5, daycareFullServiceId: svc.full });
    const audit = (await owner.get(`/api/audit?entityType=organization&entityId=${org.orgId}`)).json().items[0];
    expect(audit).toMatchObject({ action: "billing_rules.updated", changes: { halfDayMaxHours: { from: 5, to: 4.5 } } });
  });
});

describe("invoices follow the rules, and match the estimate", () => {
  it("per night plus daycare, with a discount for the second pet", async () => {
    await owner.put("/api/settings/billing", rules({ boardingMode: "nights_plus_daycare", additionalPetDiscountBps: 1000 }));
    const { estimate, lines, subtotal } = await bookAndInvoice("boarding", at("04", "14:00"), at("06", "11:00"), [pets[0]!, pets[1]!]);
    expect(lines).toEqual([
      ["Boarding — Ace, Bo (2 nights × 2 pets)", 4, 5500, 1100],
      ["Daycare — Full Day during stay — Ace, Bo (1 day × 2 pets)", 2, 3800, 380],
      ["Daycare — Half Day during stay — Ace, Bo (2 days × 2 pets)", 4, 2600, 520],
    ]);
    expect(estimate.lines.map((l) => [l.kind, l.units, l.amountCents])).toEqual([["stay", 2, 20900], ["daycare_full", 1, 7220], ["daycare_half", 2, 9880]]);
    expect(subtotal).toBe(estimate.totalCents);
    expect(estimate.totalCents).toBe(38000);
  });

  it("per 24 hours, with extra time as another period or as daycare", async () => {
    await owner.put("/api/settings/billing", rules({ boardingMode: "per_24_hours", boardingExtraTime: "extra_night" }));
    let r = await bookAndInvoice("boarding", at("07", "14:00"), at("09", "17:00"), [pets[2]!]);
    expect(r.lines).toEqual([["Boarding — Cy (3 24-hour periods)", 3, 5500, 0]]);
    await owner.put("/api/settings/billing", rules({ boardingMode: "per_24_hours", boardingExtraTime: "daycare" }));
    r = await bookAndInvoice("boarding", at("10", "14:00"), at("12", "17:00"), [pets[2]!]);
    expect(r.lines).toEqual([["Boarding — Cy (2 24-hour periods)", 2, 5500, 0], ["Daycare — Half Day after the last 24 hours — Cy (1 day)", 1, 2600, 0]]);
    expect(r.subtotal).toBe(r.estimate.totalCents);
  });

  it("daycare becomes a full day after the half-day limit plus grace", async () => {
    await owner.put("/api/settings/billing", rules({ halfDayMaxHours: 5 }));
    expect((await bookAndInvoice("full", at("14", "08:00"), at("14", "13:15"), [pets[3]!])).lines).toEqual([["Daycare — Half Day — Di (1 day)", 1, 2600, 0]]);
    expect((await bookAndInvoice("half", at("15", "08:00"), at("15", "13:45"), [pets[3]!])).lines).toEqual([["Daycare — Full Day — Di (1 day)", 1, 3800, 0]]);
    // Other services are unaffected by the rules.
    expect((await bookAndInvoice("groom", at("16", "10:00"), at("16", "12:00"), [pets[4]!])).lines).toEqual([["Groom — Ed (1 visit)", 1, 8500, 0]]);
  });

  it("the default per-night rule still bills nights only", async () => {
    await owner.put("/api/settings/billing", rules({ boardingMode: "nights" }));
    const r = await bookAndInvoice("boarding", at("18", "14:00"), at("20", "17:00"), [pets[5]!]);
    expect(r.lines).toEqual([["Boarding — Fi (2 nights)", 2, 5500, 0]]);
  });
});

describe("tenant isolation", () => {
  it("each organization has its own rules and can't point at another's services", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get("/api/settings/billing")).json()).toMatchObject({ boardingMode: "nights", daycareFullServiceId: null });
    const res = await outsider.put("/api/settings/billing", rules({ daycareFullServiceId: svc.full, daycareHalfServiceId: null }));
    expect(res.json().error.fields[0]).toEqual({ path: "daycareFullServiceId", message: "Choose a daycare service priced per day" });
  });
});
