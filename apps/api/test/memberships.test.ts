import { addDays, calendarDate, membershipPeriodStart, zonedDateTime } from "@pawguild/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
const svc: Record<string, string> = {};
let planId: string;
let customerId: string;
let pet: string;
let membershipId: string;

const TZ = "America/New_York";
const today = calendarDate(new Date(), TZ);
const t = (date: string, time: string) => zonedDateTime(date, time, TZ).toISOString();
type Membership = { id: string; status: string; nextBillOn: string | null; endsOn: string | null; due: boolean;
  current: { periodStart: string; periodEnd: string; remaining: number } | null; periods: { periodStart: string; periodEnd: string; invoiceId: string; invoiceStatus: string }[] };
const memberships = async () => (await desk.get(`/api/customers/${customerId}/memberships`)).json().items as Membership[];

async function daycareInvoice(date: string) {
  const r = (await desk.post("/api/reservations", {
    customerId, locationId: org.locationId, serviceId: svc.full, petIds: [pet], startsAt: t(date, "08:00"), endsAt: t(date, "17:00"), status: "confirmed",
  })).json();
  return (await desk.post(`/api/reservations/${r.id}/invoice`)).json() as {
    id: string; lines: { description: string; unitPriceCents: number }[]; packages: { usedFrom: { name: string; remaining: number; expiresOn: string }[] };
  };
}

/** Move a membership's sign-up (and its billed months) back by n months, as if time had passed. */
async function backdate(id: string, months: number) {
  const m = await ctx.ownerDb.selectFrom("customerMemberships").select("startedOn").where("id", "=", id).executeTakeFirstOrThrow();
  const startedOn = membershipPeriodStart(m.startedOn, -months);
  await ctx.ownerDb.updateTable("customerMemberships").set({ startedOn }).where("id", "=", id).execute();
  const periods = await ctx.ownerDb.selectFrom("membershipPeriods").select(["id", "periodStart"]).where("customerMembershipId", "=", id).orderBy("periodStart").execute();
  for (const [k, p] of periods.entries()) {
    await ctx.ownerDb.updateTable("membershipPeriods")
      .set({ periodStart: membershipPeriodStart(startedOn, k), periodEnd: addDays(membershipPeriodStart(startedOn, k + 1), -1) }).where("id", "=", p.id).execute();
  }
}

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "manager", "front_desk", "care_attendant"]);
  owner = await login(ctx.app, org.users.owner!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  svc.full = (await owner.post("/api/services", { name: "Daycare — Full Day", category: "daycare", priceCents: 3800, priceUnit: "per_day" })).json().id;
  svc.half = (await owner.post("/api/services", { name: "Daycare — Half Day", category: "daycare", priceCents: 2600, priceUnit: "per_day" })).json().id;
  await owner.put("/api/settings/billing", {
    boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30, daytimeStart: "07:00", daytimeEnd: "19:00",
    daycareFullServiceId: svc.full, daycareHalfServiceId: svc.half, additionalPetDiscountBps: 0,
  });
  customerId = (await desk.post("/api/customers", { firstName: "Mia", lastName: "Member" })).json().id;
  pet = (await desk.post("/api/pets", { customerId, name: "Rufus", species: "dog" })).json().id;
});
afterAll(async () => { await ctx.close(); });

describe("plans", () => {
  it("owners set up plans; managers can't", async () => {
    const body = { name: "Full-Day Club", covers: "full_day", daysPerMonth: 8, priceCents: 28000 };
    expect((await manager.post("/api/membership-plans", body)).statusCode).toBe(403);
    expect((await owner.post("/api/membership-plans", { ...body, daysPerMonth: 40 })).json().error.fields[0].path).toBe("daysPerMonth");
    const res = await owner.post("/api/membership-plans", body);
    expect(res.statusCode).toBe(201);
    planId = res.json().id;
    expect((await owner.post("/api/membership-plans", body)).json().error.fields[0].message).toBe("There's already a plan with this name");
    expect((await desk.get("/api/membership-plans")).json().items).toHaveLength(1);
  });
});

describe("signing up", () => {
  it("bills the first month in full on the sign-up date", async () => {
    expect((await care.post(`/api/customers/${customerId}/memberships`, { planId })).statusCode).toBe(403);
    expect((await desk.post(`/api/customers/${customerId}/memberships`, { planId, startsOn: addDays(today, -1) })).json().error.fields[0].path).toBe("startsOn");
    const res = await desk.post(`/api/customers/${customerId}/memberships`, { planId });
    expect(res.statusCode).toBe(201);
    const { membership, invoiceId } = res.json();
    membershipId = membership.id;
    const end = addDays(membershipPeriodStart(today, 1), -1);
    expect(membership).toMatchObject({ status: "active", startedOn: today, nextBillOn: membershipPeriodStart(today, 1), due: false,
      current: { periodStart: today, periodEnd: end, remaining: 8 } });
    const inv = (await desk.get(`/api/invoices/${invoiceId}`)).json();
    expect(inv).toMatchObject({ status: "issued", totals: { totalCents: 28000 } });
    expect(inv.lines[0].description).toMatch(/^Full-Day Club membership — 8 full days of daycare, /);
    expect((await desk.post(`/api/customers/${customerId}/memberships`, { planId })).json().error.code).toBe("already_member");
  });

  it("uses this month's days before packages, and only for dates in the month", async () => {
    const pkg = (await owner.post("/api/package-products", { name: "10 Full Days", covers: "full_day", days: 10, priceCents: 34000, expiresAfterDays: 365 })).json().id;
    await desk.post(`/api/customers/${customerId}/packages`, { productId: pkg });
    const inMonth = await daycareInvoice(addDays(today, 1));
    expect(inMonth.lines.map((l) => [l.description, l.unitPriceCents])).toEqual([["Daycare — Full Day — Rufus (1 day prepaid: Full-Day Club membership)", 0]]);
    expect(inMonth.packages.usedFrom[0]).toMatchObject({ name: "Full-Day Club membership", remaining: 7, expiresOn: addDays(membershipPeriodStart(today, 1), -1) });
    // Next month isn't billed yet, so its days aren't available: the package is used.
    const nextMonth = await daycareInvoice(addDays(membershipPeriodStart(today, 1), 1));
    expect(nextMonth.lines[0]!.description).toBe("Daycare — Full Day — Rufus (1 day prepaid: 10 Full Days)");
    expect((await memberships())[0]!.current!.remaining).toBe(7);
  });
});

describe("renewals", () => {
  it("bills each month that's due on the sign-up day, once", async () => {
    await backdate(membershipId, 2);
    let [m] = await memberships();
    expect(m).toMatchObject({ due: true, nextBillOn: membershipPeriodStart(m!.periods[0]!.periodStart, 1) });
    expect((await desk.get("/api/notifications")).json().items.find((i: { kind: string }) => i.kind === "memberships_due"))
      .toMatchObject({ title: "1 membership due to be billed", link: "/memberships" });
    expect((await care.post("/api/memberships/bill-due")).statusCode).toBe(403);
    const res = (await desk.post("/api/memberships/bill-due")).json();
    expect(res.billed.map((b: { periodStart: string }) => b.periodStart)).toEqual([membershipPeriodStart(today, -1), today]);
    expect((await desk.post("/api/memberships/bill-due")).json().billed).toEqual([]);
    [m] = await memberships();
    expect(m!.periods).toHaveLength(3);
    // Unused days don't roll over: the new month starts with the plan's 8.
    expect(m).toMatchObject({ due: false, current: { periodStart: today, remaining: 8 } });
    const all = (await desk.get("/api/memberships")).json();
    expect(all).toMatchObject({ dueCount: 0, items: [{ customerName: "Member, Mia", status: "active" }] });
  });

  it("days from a month whose invoice was voided can't be used", async () => {
    const [m] = await memberships();
    const current = m!.periods.find((p) => p.periodStart === today)!;
    await owner.post(`/api/invoices/${current.invoiceId}/void`, { reason: "Billed by mistake" });
    const inv = await daycareInvoice(addDays(today, 2));
    expect(inv.lines[0]!.description).toBe("Daycare — Full Day — Rufus (1 day prepaid: 10 Full Days)");
  });
});

describe("cancelling", () => {
  it("ends on the last day of the paid month, stops billing, and can be undone until then", async () => {
    const res = await desk.post(`/api/memberships/${membershipId}/cancel`, { reason: "Moving away" });
    const lastEnd = addDays(membershipPeriodStart(today, 1), -1);
    expect(res.json()).toMatchObject({ status: "ending", endsOn: lastEnd, nextBillOn: null, cancelReason: "Moving away" });
    expect((await desk.post(`/api/memberships/${membershipId}/cancel`, {})).json().error.code).toBe("already_cancelled");
    await backdate(membershipId, 1);
    // A month later there's nothing to bill.
    await ctx.ownerDb.updateTable("customerMemberships").set({ endsOn: addDays(today, -1) }).where("id", "=", membershipId).execute();
    expect((await desk.post("/api/memberships/bill-due")).json().billed).toEqual([]);
    expect((await memberships())[0]).toMatchObject({ status: "ended", due: false });
    expect((await desk.post(`/api/memberships/${membershipId}/reinstate`)).json().error.code).toBe("already_ended");
  });

  it("can be undone before it ends", async () => {
    const other = (await desk.post("/api/customers", { firstName: "Ned", lastName: "Next" })).json().id;
    const m = (await desk.post(`/api/customers/${other}/memberships`, { planId })).json().membership;
    await desk.post(`/api/memberships/${m.id}/cancel`, {});
    const back = (await desk.post(`/api/memberships/${m.id}/reinstate`)).json();
    expect(back).toMatchObject({ status: "active", endsOn: null, nextBillOn: membershipPeriodStart(today, 1) });
  });

  it("cancelled before the first bill, nothing is ever billed", async () => {
    const other = (await desk.post("/api/customers", { firstName: "Fay", lastName: "Future" })).json().id;
    const res = (await desk.post(`/api/customers/${other}/memberships`, { planId, startsOn: addDays(today, 5) })).json();
    expect(res).toMatchObject({ invoiceId: null, membership: { status: "upcoming", nextBillOn: addDays(today, 5) } });
    await desk.post(`/api/memberships/${res.membership.id}/cancel`, {});
    await ctx.ownerDb.updateTable("customerMemberships").set({ startedOn: addDays(today, -1), endsOn: addDays(today, -1) }).where("id", "=", res.membership.id).execute();
    expect((await desk.post("/api/memberships/bill-due")).json().billed).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("other organizations can't see, use or change our memberships", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    const theirs = (await outsider.post("/api/customers", { firstName: "O", lastName: "T" })).json().id;
    expect((await outsider.post(`/api/customers/${theirs}/memberships`, { planId })).json().error.fields[0].path).toBe("planId");
    expect((await outsider.get(`/api/customers/${customerId}/memberships`)).statusCode).toBe(404);
    expect((await outsider.post(`/api/memberships/${membershipId}/cancel`, {})).statusCode).toBe(404);
    expect((await outsider.get("/api/memberships")).json().items).toEqual([]);
    expect((await outsider.post("/api/memberships/bill-due")).json().billed).toEqual([]);
  });
});

describe("memberships report", () => {
  it("counts members, monthly fees, months billed, days used, sign-ups and cancellations", async () => {
    const o = await createOrg(ctx.ownerDb, ["owner", "front_desk"]);
    const boss = await login(ctx.app, o.users.owner!.email);
    const fd = await login(ctx.app, o.users.front_desk!.email);
    const full = (await boss.post("/api/services", { name: "Daycare — Full Day", category: "daycare", priceCents: 3800, priceUnit: "per_day" })).json().id;
    await boss.put("/api/settings/billing", {
      boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30, daytimeStart: "07:00", daytimeEnd: "19:00",
      daycareFullServiceId: full, daycareHalfServiceId: null, additionalPetDiscountBps: 0,
    });
    const plan = (await boss.post("/api/membership-plans", { name: "Club", covers: "full_day", daysPerMonth: 8, priceCents: 28000 })).json().id;
    const small = (await boss.post("/api/membership-plans", { name: "Lite", covers: "full_day", daysPerMonth: 4, priceCents: 15000 })).json().id;
    const people: string[] = [];
    for (const name of ["Ann", "Ben", "Cal"]) people.push((await fd.post("/api/customers", { firstName: name, lastName: "Report" })).json().id);
    await fd.post(`/api/customers/${people[0]}/memberships`, { planId: plan });
    await fd.post(`/api/customers/${people[1]}/memberships`, { planId: plan });
    const lite = (await fd.post(`/api/customers/${people[2]}/memberships`, { planId: small })).json().membership.id;
    await fd.post(`/api/memberships/${lite}/cancel`, { reason: "Too few days" });
    // Ann uses one included day.
    const dog = (await fd.post("/api/pets", { customerId: people[0], name: "Dot", species: "dog" })).json().id;
    const r = (await fd.post("/api/reservations", {
      customerId: people[0], locationId: o.locationId, serviceId: full, petIds: [dog], startsAt: t(addDays(today, 1), "08:00"), endsAt: t(addDays(today, 1), "17:00"), status: "confirmed",
    })).json();
    await fd.post(`/api/reservations/${r.id}/invoice`);

    expect((await fd.get(`/api/reports/memberships?from=${today}&to=${today}`)).statusCode).toBe(403);
    const rep = (await boss.get(`/api/reports/memberships?from=${today}&to=${today}`)).json();
    expect(rep.totals).toEqual({
      members: 3, ending: 1, monthlyRecurringCents: 56000, monthsBilled: 3, revenueCents: 71000,
      daysIncluded: 20, daysUsed: 1, signups: 3, cancellations: 1,
    });
    expect(rep.byPlan.map((p: { plan: string; members: number }) => [p.plan, p.members])).toEqual([["Club", 2], ["Lite", 1]]);
    expect((await boss.get(`/api/reports/memberships?from=${addDays(today, -30)}&to=${addDays(today, -1)}`)).json().totals)
      .toMatchObject({ monthsBilled: 0, signups: 0, cancellations: 0, members: 3 });
  });
});
