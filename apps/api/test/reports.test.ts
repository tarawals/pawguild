/**
 * Reports must reconcile exactly with the records they summarize: sales with issued invoices,
 * payments with the payment/refund/deposit ledgers, balances with the dashboard and customer
 * pages. Also covers date ranges, permissions and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let lead: Awaited<ReturnType<typeof login>>;
let svc: { boarding: { id: string }; grooming: { id: string }; daycare: { id: string } };
let customers: { id: string }[] = [];
let invoiceIds: string[] = [];

const TZ = "America/New_York";
const localDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const today = localDate(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const yesterday = addDays(today, -1);

async function issuedInvoice(customerId: string, lines: object[]) {
  const inv = (await desk.post("/api/invoices", { customerId, locationId: org.locationId })).json();
  for (const line of lines) { const r = await desk.post(`/api/invoices/${inv.id}/lines`, line); expect(r.statusCode, r.body).toBe(201); }
  const issued = await desk.post(`/api/invoices/${inv.id}/issue`);
  expect(issued.statusCode).toBe(200);
  invoiceIds.push(inv.id);
  return issued.json() as { id: string; totalCents: number; taxCents: number; balanceCents: number };
}

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "shift_lead"]);
  await ctx.ownerDb.updateTable("locations").set({ taxRateBps: 1000 }).where("id", "=", org.locationId).execute();
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  lead = await login(ctx.app, org.users.shift_lead!.email);
  svc = {
    boarding: (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json(),
    grooming: (await manager.post("/api/services", { name: "Full Groom", category: "grooming", priceCents: 3000, priceUnit: "per_visit", isTaxable: true })).json(),
    daycare: (await manager.post("/api/services", { name: "Daycare", category: "daycare", priceCents: 3500, priceUnit: "per_day" })).json(),
  };
  for (const name of ["Ames", "Baker", "Cole"]) customers.push((await desk.post("/api/customers", { firstName: "Pat", lastName: name })).json());
});
afterAll(async () => { await ctx.close(); });

describe("sales report", () => {
  it("is empty for a new organization and rejects bad ranges", async () => {
    const res = await lead.get(`/api/reports/sales?from=${today}&to=${today}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ timeZone: TZ, totals: { invoices: 0, invoicedCents: 0, salesAfterCreditsCents: 0 }, byService: [], byMonth: [] });
    expect((await lead.get(`/api/reports/sales?from=${today}&to=${yesterday}`)).statusCode).toBe(400);
    expect((await lead.get(`/api/reports/sales?from=2024-01-01&to=2026-01-01`)).statusCode).toBe(400);
    expect((await lead.get(`/api/reports/sales?from=nope&to=${today}`)).statusCode).toBe(400);
    expect((await lead.get(`/api/reports/sales`)).statusCode).toBe(400);
  });

  it("matches issued invoices exactly, per service, with tax and discounts", async () => {
    const [a, b, c] = customers as [{ id: string }, { id: string }, { id: string }];
    await issuedInvoice(a.id, [
      { serviceId: svc.boarding.id, quantity: 3 },                         // 150.00, not taxable
      { serviceId: svc.grooming.id, quantity: 1, discountCents: 500 },     // 25.00 taxable
    ]);
    await issuedInvoice(b.id, [
      { serviceId: svc.grooming.id, quantity: 2 },                         // 60.00 taxable
      { description: "Nail trim", quantity: 1, unitPriceCents: 1234 },     // custom, not taxable
    ]);
    await issuedInvoice(c.id, [{ serviceId: svc.daycare.id, quantity: 4, discountCents: 1000 }]); // 130.00
    // Drafts and void invoices are not sales.
    const draft = (await desk.post("/api/invoices", { customerId: c.id, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${draft.id}/lines`, { serviceId: svc.boarding.id, quantity: 10 });
    const voided = await issuedInvoice(c.id, [{ serviceId: svc.boarding.id, quantity: 2 }]);
    invoiceIds = invoiceIds.filter((id) => id !== voided.id);
    expect((await manager.post(`/api/invoices/${voided.id}/void`, { reason: "Entered twice" })).statusCode).toBe(200);

    const report = (await lead.get(`/api/reports/sales?from=${today}&to=${today}`)).json();
    const invoices = await Promise.all(invoiceIds.map(async (id) => (await desk.get(`/api/invoices/${id}`)).json().totals));
    const sum = (f: (i: { subtotalCents: number; discountCents: number; taxCents: number; totalCents: number }) => number) =>
      invoices.reduce((acc, i) => acc + f(i), 0);
    expect(report.totals).toEqual({
      invoices: 3,
      grossCents: sum((i) => i.subtotalCents),
      discountCents: sum((i) => i.discountCents),
      netCents: sum((i) => i.subtotalCents - i.discountCents),
      taxCents: sum((i) => i.taxCents),
      invoicedCents: sum((i) => i.totalCents),
      creditNotesCents: 0, creditNotes: 0,
      salesAfterCreditsCents: sum((i) => i.totalCents),
    });
    // Hand-checked: gross 150 + 30 + 60 + 12.34 + 140 = 392.34; discounts 15.00; tax 10% of 85.00.
    expect(report.totals).toMatchObject({ grossCents: 39234, discountCents: 1500, netCents: 37734, taxCents: 850, invoicedCents: 38584 });
    expect(report.byService).toEqual([
      { service: "Boarding", category: "boarding", quantity: 3, grossCents: 15000, discountCents: 0, netCents: 15000 },
      { service: "Daycare", category: "daycare", quantity: 4, grossCents: 14000, discountCents: 1000, netCents: 13000 },
      { service: "Full Groom", category: "grooming", quantity: 3, grossCents: 9000, discountCents: 500, netCents: 8500 },
      { service: "Custom items", category: null, quantity: 1, grossCents: 1234, discountCents: 0, netCents: 1234 },
    ]);
    expect(report.byService.reduce((a: number, s: { netCents: number }) => a + s.netCents, 0)).toBe(report.totals.netCents);
    expect(report.byMonth).toEqual([{ month: today.slice(0, 7), invoices: 3, netCents: 37734, taxCents: 850, creditNotesCents: 0 }]);
  });

  it("subtracts credit notes and excludes days outside the range", async () => {
    await manager.post(`/api/invoices/${invoiceIds[0]}/credit-notes`, { amountCents: 2000, reason: "Goodwill" });
    const report = (await lead.get(`/api/reports/sales?from=${today}&to=${today}`)).json();
    expect(report.totals).toMatchObject({ creditNotes: 1, creditNotesCents: 2000, salesAfterCreditsCents: 38584 - 2000 });
    expect(report.byMonth[0].creditNotesCents).toBe(2000);
    const before = (await lead.get(`/api/reports/sales?from=${addDays(today, -30)}&to=${yesterday}`)).json();
    expect(before.totals).toMatchObject({ invoices: 0, invoicedCents: 0, creditNotesCents: 0 });
  });
});

describe("payments report", () => {
  it("reconciles money in and out by method, excluding account credit movements", async () => {
    const [i1, i2, i3] = invoiceIds as [string, string, string];
    const inv1 = (await desk.get(`/api/invoices/${i1}`)).json().totals;
    // Invoice 1: pay the balance by card, then a second credit note leaves it overpaid by 20.00.
    const card = inv1.totalCents - 2000;
    expect((await desk.post(`/api/invoices/${i1}/payments`, { amountCents: card, method: "card" })).statusCode).toBe(201);
    await manager.post(`/api/invoices/${i1}/credit-notes`, { amountCents: 2000, reason: "Early pickup" });
    await manager.post(`/api/invoices/${i1}/refunds`, { amountCents: 1500, method: "card", reason: "Goodwill" });
    await manager.post(`/api/invoices/${i1}/refunds`, { amountCents: 500, method: "account_credit", reason: "Keep for later" });
    // Invoice 2: cash in part, then a deposit applied from credit, one voided payment.
    await desk.post(`/api/invoices/${i2}/payments`, { amountCents: 2000, method: "cash" });
    const wrong = (await desk.post(`/api/invoices/${i2}/payments`, { amountCents: 999, method: "check" })).json();
    await manager.post(`/api/payments/${wrong.payments.find((p: { method: string }) => p.method === "check").id}/void`, { reason: "Bounced" });
    await desk.post(`/api/customers/${customers[1]!.id}/credits`, { amountCents: 3000, method: "cash", note: "Prepaid" });
    await desk.post(`/api/invoices/${i2}/apply-credit`, { amountCents: 2500 });
    // Invoice 3: a payment received yesterday (backdated) is outside today's range.
    const yesterdayNoon = new Date(Date.parse(`${yesterday}T12:00:00-04:00`)).toISOString();
    await desk.post(`/api/invoices/${i3}/payments`, { amountCents: 700, method: "card", receivedAt: yesterdayNoon });

    const report = (await lead.get(`/api/reports/payments?from=${today}&to=${today}`)).json();
    expect(report.payments).toEqual([
      { method: "account_credit", count: 1, cents: 2500 },
      { method: "card", count: 1, cents: card },
      { method: "cash", count: 1, cents: 2000 },
    ]);
    expect(report.refunds).toEqual([{ method: "account_credit", count: 1, cents: 500 }, { method: "card", count: 1, cents: 1500 }]);
    expect(report.deposits).toEqual([{ method: "cash", count: 1, cents: 3000 }]);
    expect(report.totals).toEqual({
      paymentsCents: card + 2000, creditAppliedCents: 2500, depositsCents: 3000,
      refundsCents: 1500, movedToCreditCents: 500, netCollectedCents: card + 2000 + 3000 - 1500,
    });
    expect(report.byMethod).toEqual([
      { method: "card", inCents: card, outCents: 1500, netCents: card - 1500 },
      { method: "cash", inCents: 5000, outCents: 0, netCents: 5000 },
    ]);
    const net = report.byMethod.reduce((a: number, m: { netCents: number }) => a + m.netCents, 0);
    expect(net).toBe(report.totals.netCollectedCents);

    const both = (await lead.get(`/api/reports/payments?from=${yesterday}&to=${today}`)).json();
    expect(both.totals.paymentsCents).toBe(report.totals.paymentsCents + 700);
    const onlyYesterday = (await lead.get(`/api/reports/payments?from=${yesterday}&to=${yesterday}`)).json();
    expect(onlyYesterday.payments).toEqual([{ method: "card", count: 1, cents: 700 }]);
  });
});

describe("balances report", () => {
  it("agrees with the dashboard, customer pages and invoice list", async () => {
    const report = (await lead.get("/api/reports/balances")).json();
    const dashboard = (await desk.get("/api/dashboard/summary")).json();
    expect(report.totals.owedCents).toBe(dashboard.outstanding.cents);
    for (const c of customers) {
      const billing = (await desk.get(`/api/customers/${c.id}`)).json().billing;
      const row = report.items.find((r: { customerId: string }) => r.customerId === c.id);
      expect({ owedCents: row?.owedCents ?? 0, overpaidCents: row?.overpaidCents ?? 0, creditCents: row?.creditCents ?? 0 })
        .toEqual({ owedCents: billing.owedCents, overpaidCents: billing.overpaidCents, creditCents: billing.creditCents });
    }
    // Cole owes daycare less 7.00; Baker owes 78.34 - 45.00 with 5.00 credit left; Ames is settled with 5.00 credit.
    expect(report.items.map((r: { customerName: string }) => r.customerName)).toEqual(["Cole, Pat", "Baker, Pat", "Ames, Pat"]);
    expect(report.items[0]).toMatchObject({ owedCents: 13000 - 700, creditCents: 0 });
    expect(report.items[1]).toMatchObject({ owedCents: 7834 - 4500, creditCents: 500 });
    expect(report.items[2]).toMatchObject({ owedCents: 0, overpaidCents: 0, creditCents: 500 });
    expect(report.items[0].oldestUnpaid).toBeTruthy();
    expect(report.totals.creditCents).toBe(1000);
  });
});

describe("occupancy report", () => {
  it("counts pets per night and leaves out cancelled stays", async () => {
    await ctx.ownerDb.insertInto("locationCapacities")
      .values([{ organizationId: org.orgId, locationId: org.locationId, category: "boarding", maxPets: 4 }]).execute();
    const pets = await Promise.all(["Rex", "Ivy", "Moe"].map(async (name) =>
      (await desk.post("/api/pets", { customerId: customers[0]!.id, name, species: "dog" })).json().id as string));
    const d = (offset: number, time: string) => `${addDays(today, offset)}T${time}:00-04:00`;
    const book = async (petIds: string[], from: number, to: number, service = svc.boarding.id) =>
      (await desk.post("/api/reservations", {
        customerId: customers[0]!.id, locationId: org.locationId, serviceId: service, petIds,
        startsAt: d(from, "14:00"), endsAt: d(to, "11:00"), status: "confirmed",
      })).json();
    await book([pets[0]!, pets[1]!], 10, 13);                 // nights 10, 11, 12 × 2 pets
    const cancelled = await book([pets[2]!], 10, 12);
    expect((await desk.post(`/api/reservations/${cancelled.id}/status`, { status: "cancelled", reason: "Plans changed" })).statusCode).toBe(200);

    const report = (await lead.get(`/api/reports/occupancy?from=${addDays(today, 10)}&to=${addDays(today, 13)}`)).json();
    const loc = report.locations.find((l: { locationId: string }) => l.locationId === org.locationId);
    expect(loc.days.map((x: { boarding: number }) => x.boarding)).toEqual([2, 2, 2, 0]);
    expect(loc.boarding).toEqual({ petDays: 6, averagePerDay: 1.5, peak: 2, utilizationPercent: 37.5, limit: 4 });
    expect(loc.daycare.limit).toBeNull();
    expect(loc.daycare.utilizationPercent).toBeNull();
  });
});

describe("access", () => {
  it("front desk can't read reports; other organizations see nothing of ours", async () => {
    for (const path of ["sales", "payments", "occupancy"]) {
      expect((await desk.get(`/api/reports/${path}?from=${today}&to=${today}`)).statusCode).toBe(403);
    }
    expect((await desk.get("/api/reports/balances")).statusCode).toBe(403);
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get(`/api/reports/sales?from=${today}&to=${today}`)).json().totals.invoices).toBe(0);
    expect((await outsider.get(`/api/reports/payments?from=${today}&to=${today}`)).json().payments).toEqual([]);
    expect((await outsider.get("/api/reports/balances")).json().items).toEqual([]);
    const occ = (await outsider.get(`/api/reports/occupancy?from=${addDays(today, 10)}&to=${addDays(today, 13)}`)).json();
    expect(occ.locations.map((l: { locationId: string }) => l.locationId)).toEqual([other.locationId]);
    expect(occ.locations[0].boarding.petDays).toBe(0);
  });
});
