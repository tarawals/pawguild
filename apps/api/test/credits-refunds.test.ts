import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let customer: { id: string };
let reservation: { id: string };
let invoiceId: string;
let tenant: { orgId: string; userId: string };

const at = (d: string, t: string) => `${d}T${t}:00-04:00`;
const credit = async () => (await desk.get(`/api/customers/${customer.id}/credits`)).json().balanceCents as number;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk"]);
  tenant = { orgId: org.orgId, userId: org.users.manager!.id };
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  const boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5500, priceUnit: "per_night" })).json();
  customer = (await desk.post("/api/customers", { firstName: "Cred", lastName: "It" })).json();
  const pet = (await desk.post("/api/pets", { customerId: customer.id, name: "Kip", species: "dog" })).json();
  reservation = (await desk.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [pet.id],
    startsAt: at("2026-07-01", "14:00"), endsAt: at("2026-07-04", "11:00"), status: "confirmed",
  })).json();
});
afterAll(async () => { await ctx.close(); });

describe("deposits and account credit", () => {
  it("takes a deposit against a reservation", async () => {
    const res = await desk.post(`/api/customers/${customer.id}/credits`, { amountCents: 5000, method: "card", reference: "Visa 1111", reservationId: reservation.id });
    expect(res.statusCode).toBe(201);
    expect(res.json().balanceCents).toBe(5000);
    expect((await desk.get(`/api/reservations/${reservation.id}`)).json().depositsCents).toBe(5000);
    expect((await desk.get(`/api/customers/${customer.id}`)).json().billing.creditCents).toBe(5000);

    const other = (await desk.post("/api/customers", { firstName: "Oth", lastName: "Er" })).json();
    expect((await desk.post(`/api/customers/${other.id}/credits`, { amountCents: 100, method: "cash", reservationId: reservation.id })).statusCode).toBe(422);
    expect((await desk.post(`/api/customers/${customer.id}/credits`, { amountCents: 0, method: "cash" })).statusCode).toBe(400);
  });

  it("applies credit to an invoice, never more than the credit or the balance", async () => {
    invoiceId = (await desk.post(`/api/reservations/${reservation.id}/invoice`)).json().id;
    expect((await desk.post(`/api/invoices/${invoiceId}/apply-credit`, { amountCents: 1000 })).statusCode).toBe(409); // still a draft
    const issued = (await desk.post(`/api/invoices/${invoiceId}/issue`)).json();
    expect(issued).toMatchObject({ balanceCents: 16500, customerCreditCents: 5000 });

    const tooMuch = await desk.post(`/api/invoices/${invoiceId}/apply-credit`, { amountCents: 6000 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json().error.fields[0].message).toMatch(/only has \$50\.00 of account credit/);

    const applied = await desk.post(`/api/invoices/${invoiceId}/apply-credit`, { amountCents: 5000 });
    expect(applied.json()).toMatchObject({ balanceCents: 11500, customerCreditCents: 0, paymentStatus: "partially_paid" });
    expect(applied.json().payments[0]).toMatchObject({ method: "account_credit", amountCents: 5000 });
    expect(await credit()).toBe(0);

    const paid = await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 11500, method: "card" });
    expect(paid.json().paymentStatus).toBe("paid");
  });
});

describe("credit notes and refunds", () => {
  it("only managers issue credit notes, never more than the invoice total", async () => {
    expect((await desk.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 5500, reason: "Left early" })).statusCode).toBe(403);
    expect((await manager.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 20000, reason: "x" })).statusCode).toBe(400);
    expect((await manager.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 5500 })).statusCode).toBe(400); // reason required
    const res = await manager.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 5500, reason: "Picked up a night early" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ creditNotesCents: 5500, balanceCents: -5500, paymentStatus: "overpaid" });
    expect((await desk.get("/api/invoices?status=overpaid")).json().items.map((i: { id: string }) => i.id)).toEqual([invoiceId]);
    expect((await desk.get("/api/dashboard/summary")).json().outstanding).toMatchObject({ cents: 0, overpaidInvoices: 1 });
    expect((await desk.get(`/api/customers/${customer.id}`)).json().billing).toMatchObject({ owedCents: 0, overpaidCents: 5500 });
  });

  it("refunds an overpayment partly to card and the rest to account credit", async () => {
    expect((await desk.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 1000, method: "card", reason: "x" })).statusCode).toBe(403);
    const over = await manager.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 6000, method: "card", reason: "Early pickup" });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.fields[0].message).toMatch(/more than was overpaid \(\$55\.00\)/);

    const card = await manager.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 2500, method: "card", reference: "Visa 1111", reason: "Early pickup" });
    expect(card.json()).toMatchObject({ balanceCents: -3000, refundsCents: 2500, paymentStatus: "overpaid" });
    const toCredit = await manager.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 3000, method: "account_credit", reason: "Keep for next visit" });
    expect(toCredit.json()).toMatchObject({ balanceCents: 0, paymentStatus: "paid", customerCreditCents: 3000 });
    expect((await manager.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 1, method: "cash", reason: "x" })).statusCode).toBe(409);

    const audit = (await manager.get(`/api/audit?entityType=invoice&entityId=${invoiceId}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit.slice(0, 3)).toEqual(["invoice.overpayment_to_credit", "invoice.refunded", "invoice.credited"]);
  });

  it("won't void payments on an invoice that has refunds", async () => {
    const pay = (await desk.get(`/api/invoices/${invoiceId}`)).json().payments.find((p: { method: string }) => p.method === "card");
    const res = await manager.post(`/api/payments/${pay.id}/void`, { reason: "oops" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("has_refunds");
  });

  it("refunds account credit back to the customer (managers only, never more than available)", async () => {
    expect((await desk.post(`/api/customers/${customer.id}/credits/refund`, { amountCents: 1000, method: "cash", reason: "x" })).statusCode).toBe(403);
    expect((await manager.post(`/api/customers/${customer.id}/credits/refund`, { amountCents: 4000, method: "cash", reason: "Closing account" })).statusCode).toBe(400);
    const ok = await manager.post(`/api/customers/${customer.id}/credits/refund`, { amountCents: 3000, method: "cash", reason: "Closing account" });
    expect(ok.json().balanceCents).toBe(0);
    const entries = (await desk.get(`/api/customers/${customer.id}/credits`)).json().entries.map((e: { kind: string; amountCents: number }) => [e.kind, e.amountCents]);
    expect(entries).toEqual([["refunded", -3000], ["from_invoice", 3000], ["applied", -5000], ["received", 5000]]);
  });

  it("voiding a payment made from account credit gives the credit back", async () => {
    const draft = (await desk.post("/api/invoices", { customerId: customer.id, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${draft.id}/lines`, { description: "Bath", quantity: 1, unitPriceCents: 4000 });
    await desk.post(`/api/invoices/${draft.id}/issue`);
    await desk.post(`/api/customers/${customer.id}/credits`, { amountCents: 4000, method: "cash", note: "Prepaid" });
    const applied = (await desk.post(`/api/invoices/${draft.id}/apply-credit`, { amountCents: 4000 })).json();
    expect(await credit()).toBe(0);
    const voided = await manager.post(`/api/payments/${applied.payments[0].id}/void`, { reason: "Applied to wrong invoice" });
    expect(voided.json()).toMatchObject({ balanceCents: 4000 });
    expect(await credit()).toBe(4000);
  });
});

describe("database guarantees", () => {
  it("refuses overdrawn credit, over-refunds, over-crediting and any rewrite", async () => {
    await expect(withTenant(ctx.db, tenant, (trx) => sql`
      insert into account_credits (organization_id, customer_id, amount_cents, kind, refund_id, created_by_user_id)
      select ${org.orgId}, ${customer.id}, -999999, 'refunded', id, ${tenant.userId} from refunds limit 1`.execute(trx)))
      .rejects.toThrow(/more than the customer's available account credit/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`
      insert into refunds (organization_id, customer_id, invoice_id, amount_cents, method, reason, refunded_at, recorded_by_user_id)
      values (${org.orgId}, ${customer.id}, ${invoiceId}, 100, 'cash', 'x', now(), ${tenant.userId})`.execute(trx)))
      .rejects.toThrow(/more than the amount overpaid/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`
      insert into invoice_credit_notes (organization_id, invoice_id, customer_id, amount_cents, reason, created_by_user_id)
      values (${org.orgId}, ${invoiceId}, ${customer.id}, 999999, 'x', ${tenant.userId})`.execute(trx)))
      .rejects.toThrow(/can't exceed the invoice total/);
    for (const stmt of [sql`update refunds set amount_cents = 1`, sql`delete from refunds`, sql`update account_credits set amount_cents = 1`,
      sql`delete from invoice_credit_notes`]) {
      await expect(withTenant(ctx.db, tenant, (trx) => stmt.execute(trx))).rejects.toThrow(/permission denied/);
    }
  });
});

describe("credit tenant isolation", () => {
  it("keeps credits, refunds and credit notes private", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    expect((await intruder.get(`/api/customers/${customer.id}/credits`)).statusCode).toBe(404);
    expect((await intruder.post(`/api/customers/${customer.id}/credits`, { amountCents: 100, method: "cash" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/customers/${customer.id}/credits/refund`, { amountCents: 100, method: "cash", reason: "x" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 100, reason: "x" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 100, method: "cash", reason: "x" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/invoices/${invoiceId}/apply-credit`, { amountCents: 100 })).statusCode).toBe(404);
  });
});
