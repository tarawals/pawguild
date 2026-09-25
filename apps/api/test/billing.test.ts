import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let boarding: { id: string };
let nails: { id: string };
let customer: { id: string };
let reservation: { id: string };

const at = (d: string, t: string) => `${d}T${t}:00-04:00`;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5500, priceUnit: "per_night" })).json();
  nails = (await manager.post("/api/services", { name: "Nail Trim", category: "add_on", priceCents: 1500, priceUnit: "per_visit", isTaxable: true })).json();
  customer = (await desk.post("/api/customers", { firstName: "Bill", lastName: "Ing" })).json();
  const a = (await desk.post("/api/pets", { customerId: customer.id, name: "Ace", species: "dog" })).json();
  const b = (await desk.post("/api/pets", { customerId: customer.id, name: "Bea", species: "dog" })).json();
  reservation = (await desk.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [a.id, b.id],
    startsAt: at("2026-07-01", "14:00"), endsAt: at("2026-07-04", "11:00"), status: "confirmed",
  })).json();
});
afterAll(async () => { await ctx.close(); });

describe("tax settings", () => {
  it("lets location managers set the tax rate and toggles taxability per service", async () => {
    expect((await desk.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 825 })).statusCode).toBe(403);
    expect((await manager.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 825 })).statusCode).toBe(403); // manager lacks locations:manage
    const owner = await createOrgOwnerFor(org.orgId);
    expect((await owner.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 825 })).statusCode).toBe(200);
    expect((await desk.get("/api/locations")).json().items[0].taxRateBps).toBe(825);
    expect((await owner.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 10001 })).statusCode).toBe(400);

    expect(nails).toMatchObject({ isTaxable: true });
    expect((await desk.get("/api/services")).json().items.find((s: { id: string }) => s.id === boarding.id).isTaxable).toBe(false);
    const off = await manager.patch(`/api/services/${nails.id}`, { isTaxable: false });
    expect(off.json().isTaxable).toBe(false);
    await manager.patch(`/api/services/${nails.id}`, { isTaxable: true });
  });
});

let ownerSession: Awaited<ReturnType<typeof login>> | undefined;
async function createOrgOwnerFor(orgId: string) {
  if (ownerSession) return ownerSession;
  const { hashPassword } = await import("../src/auth/password");
  const { PASSWORD } = await import("./helpers");
  const email = `owner-${orgId.slice(0, 8)}@example.test`;
  const user = await ctx.ownerDb.insertInto("users").values({ email, passwordHash: await hashPassword(PASSWORD), firstName: "O", lastName: "Wner" })
    .returning("id").executeTakeFirstOrThrow();
  await ctx.ownerDb.insertInto("memberships").values({ organizationId: orgId, userId: user.id, role: "owner" }).execute();
  ownerSession = await login(ctx.app, email);
  return ownerSession;
}

describe("invoices", () => {
  let invoiceId: string;

  it("drafts an invoice from a reservation at the locked-in price", async () => {
    await manager.patch(`/api/services/${boarding.id}`, { priceCents: 9900 }); // price change after booking
    const res = await desk.post(`/api/reservations/${reservation.id}/invoice`);
    expect(res.statusCode).toBe(201);
    const inv = res.json();
    invoiceId = inv.id;
    expect(inv).toMatchObject({ status: "draft", number: null, taxRateBps: 825 });
    expect(inv.lines).toEqual([expect.objectContaining({
      description: "Boarding — Ace, Bea (3 nights × 2 pets)", quantity: 6, unitPriceCents: 5500, taxable: false, amountCents: 33000,
    })]);
    expect(inv.totals).toMatchObject({ subtotalCents: 33000, taxCents: 0, totalCents: 33000 });

    const again = await desk.post(`/api/reservations/${reservation.id}/invoice`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details.invoiceId).toBe(invoiceId);
    expect((await desk.get(`/api/reservations/${reservation.id}`)).json().invoice).toMatchObject({ id: invoiceId, status: "draft" });
  });

  it("adds taxable add-ons and custom lines with discounts; tax only on taxable lines", async () => {
    const withNails = await desk.post(`/api/invoices/${invoiceId}/lines`, { serviceId: nails.id, quantity: 2, discountCents: 300 });
    expect(withNails.statusCode).toBe(201);
    expect(withNails.json().lines[1]).toMatchObject({ description: "Nail Trim", unitPriceCents: 1500, taxable: true, amountCents: 2700 });
    const custom = await desk.post(`/api/invoices/${invoiceId}/lines`, { description: "Shampoo (retail)", quantity: 1, unitPriceCents: 1299, taxable: true });
    expect(custom.json().totals).toEqual({
      subtotalCents: 33000 + 3000 + 1299, discountCents: 300, taxableCents: 2700 + 1299,
      taxCents: 330, // 8.25% of $39.99 = $3.2992 → $3.30
      totalCents: 33000 + 3000 + 1299 - 300 + 330,
    });
    expect((await desk.post(`/api/invoices/${invoiceId}/lines`, { description: "Bad", quantity: 1, unitPriceCents: 100, discountCents: 200 })).statusCode).toBe(400);
    expect((await desk.post(`/api/invoices/${invoiceId}/lines`, { quantity: 1 })).statusCode).toBe(400);

    const lineId = custom.json().lines[2].id;
    const removed = await desk.delete(`/api/invoices/${invoiceId}/lines/${lineId}`);
    expect(removed.json().lines).toHaveLength(2);
    expect(removed.json().totals.totalCents).toBe(33000 + 2700 + 223); // 8.25% of $27.00 = $2.2275 → $2.23
  });

  it("issues with a gap-free number and locks the invoice (API and database)", async () => {
    const empty = (await desk.post("/api/invoices", { customerId: customer.id, locationId: org.locationId })).json();
    expect((await desk.post(`/api/invoices/${empty.id}/issue`)).statusCode).toBe(409);
    expect((await desk.post(`/api/invoices/${empty.id}/void`, { reason: "Created by mistake" })).statusCode).toBe(200);

    const issued = await desk.post(`/api/invoices/${invoiceId}/issue`);
    expect(issued.statusCode).toBe(200);
    expect(issued.json()).toMatchObject({ status: "issued", number: 1, paymentStatus: "unpaid", balanceCents: 35923 });

    // Tax changes after issue don't touch it.
    const owner = await createOrgOwnerFor(org.orgId);
    await owner.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 1000 });
    expect((await desk.get(`/api/invoices/${invoiceId}`)).json()).toMatchObject({ taxRateBps: 825, totals: { totalCents: 35923 } });

    const addLine = await desk.post(`/api/invoices/${invoiceId}/lines`, { description: "Late", quantity: 1, unitPriceCents: 100 });
    expect(addLine.statusCode).toBe(409);

    const tenant = { orgId: org.orgId, userId: org.users.manager!.id };
    await expect(withTenant(ctx.db, tenant, (trx) => sql`update invoices set total_cents = 1, subtotal_cents = 1, discount_cents = 0, tax_cents = 0 where id = ${invoiceId}`.execute(trx)))
      .rejects.toThrow(/cannot be changed/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`delete from invoice_lines where invoice_id = ${invoiceId}`.execute(trx)))
      .rejects.toThrow(/only change while the invoice is a draft/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`update invoices set status = 'draft' where id = ${invoiceId}`.execute(trx)))
      .rejects.toThrow(/cannot return to draft/);

    const next = (await desk.post("/api/invoices", { customerId: customer.id, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${next.id}/lines`, { description: "Bath", quantity: 1, unitPriceCents: 4000 });
    expect((await desk.post(`/api/invoices/${next.id}/issue`)).json().number).toBe(2);
  });

  it("refuses to issue totals that don't match the lines, even directly in the database", async () => {
    const draft = (await desk.post("/api/invoices", { customerId: customer.id, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${draft.id}/lines`, { description: "Walk", quantity: 1, unitPriceCents: 2000 });
    const tenant = { orgId: org.orgId, userId: org.users.manager!.id };
    await expect(withTenant(ctx.db, tenant, (trx) => sql`
      update invoices set status = 'issued', number = 999, issued_at = now(), issued_by_user_id = ${org.users.manager!.id},
        subtotal_cents = 100, discount_cents = 0, tax_cents = 0, total_cents = 100 where id = ${draft.id}`.execute(trx)))
      .rejects.toThrow(/totals do not match/);
  });
});

describe("payments and balances", () => {
  let invoiceId: string;
  beforeAll(async () => {
    invoiceId = (await desk.get("/api/invoices?status=unpaid")).json().items.find((i: { number: number }) => i.number === 1).id;
  });

  it("records partial and full payments, never more than is owed", async () => {
    const over = await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 99_999, method: "card" });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.fields[0].message).toMatch(/more than the balance due \(\$359\.23\)/);

    const part = await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 10000, method: "cash" });
    expect(part.json()).toMatchObject({ paymentStatus: "partially_paid", paidCents: 10000, balanceCents: 25923 });
    expect((await desk.get(`/api/customers/${customer.id}`)).json().balanceCents).toBe(25923 + 4000);
    expect((await desk.get("/api/dashboard/summary")).json().outstanding).toEqual({ cents: 29923, invoices: 2 });

    const full = await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 25923, method: "card", reference: "Visa 4242" });
    expect(full.json()).toMatchObject({ paymentStatus: "paid", balanceCents: 0 });
    expect((await desk.get("/api/invoices?status=paid")).json().items.map((i: { id: string }) => i.id)).toContain(invoiceId);
    expect((await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 1, method: "cash" })).statusCode).toBe(400);
  });

  it("only managers void payments, and an invoice with payments can't be voided", async () => {
    const inv = (await desk.get(`/api/invoices/${invoiceId}`)).json();
    const cash = inv.payments.find((p: { method: string }) => p.method === "cash");
    expect((await desk.post(`/api/payments/${cash.id}/void`, { reason: "Entered twice" })).statusCode).toBe(403);
    expect((await manager.post(`/api/invoices/${invoiceId}/void`, { reason: "x" })).statusCode).toBe(409);
    const voided = await manager.post(`/api/payments/${cash.id}/void`, { reason: "Entered twice" });
    expect(voided.json()).toMatchObject({ paymentStatus: "partially_paid", balanceCents: 10000 });
    expect((await manager.post(`/api/payments/${cash.id}/void`, { reason: "again" })).statusCode).toBe(404);

    const audit = (await manager.get(`/api/audit?entityType=invoice&entityId=${invoiceId}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(["payment.voided", "payment.recorded", "payment.recorded", "invoice.issued", "invoice.created"]);
  });

  it("front desk can void drafts but only managers can void issued invoices; the reservation can then be re-invoiced", async () => {
    const card = (await desk.get(`/api/invoices/${invoiceId}`)).json().payments.find((p: { method: string; voidedAt: string | null }) => p.method === "card" && !p.voidedAt);
    await manager.post(`/api/payments/${card.id}/void`, { reason: "Refunded at terminal" });
    expect((await desk.post(`/api/invoices/${invoiceId}/void`, { reason: "Wrong dates" })).statusCode).toBe(403);
    expect((await manager.post(`/api/invoices/${invoiceId}/void`, {})).statusCode).toBe(400);
    const v = await manager.post(`/api/invoices/${invoiceId}/void`, { reason: "Wrong dates" });
    expect(v.json()).toMatchObject({ status: "void", balanceCents: 0 });
    expect((await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 100, method: "cash" })).statusCode).toBe(409);
    expect((await desk.post(`/api/reservations/${reservation.id}/invoice`)).statusCode).toBe(201);
  });

  it("keeps billing away from roles without billing access", async () => {
    expect((await care.get("/api/invoices")).statusCode).toBe(403);
    expect((await care.get(`/api/customers/${customer.id}`)).json().balanceCents).toBeNull();
  });
});

describe("billing tenant isolation", () => {
  it("cannot read, pay, void or bill across organizations", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    const inv = (await desk.get("/api/invoices")).json().items[0];
    expect((await intruder.get(`/api/invoices/${inv.id}`)).statusCode).toBe(404);
    expect((await intruder.get("/api/invoices")).json().items).toHaveLength(0);
    expect((await intruder.post(`/api/invoices/${inv.id}/payments`, { amountCents: 100, method: "cash" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/invoices/${inv.id}/void`, { reason: "x" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/reservations/${reservation.id}/invoice`)).statusCode).toBe(404);
    expect((await intruder.post("/api/invoices", { customerId: customer.id, locationId: other.locationId })).statusCode).toBe(422);
    const own = (await intruder.post("/api/customers", { firstName: "I", lastName: "N" })).json();
    const draft = (await intruder.post("/api/invoices", { customerId: own.id, locationId: other.locationId })).json();
    expect((await intruder.post(`/api/invoices/${draft.id}/lines`, { serviceId: nails.id, quantity: 1 })).statusCode).toBe(422);
    expect((await intruder.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 0 })).statusCode).toBe(404);
  });
});
