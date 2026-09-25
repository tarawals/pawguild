import {
  estimateReservation, formatMoney, invoiceCreateInput, invoiceLineInput, invoiceTotals, invoiceVoidInput,
  paymentInput, PRICE_UNIT_LABELS, type PriceUnit,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { recordAudit } from "../lib/audit";
import { locationTimezone } from "../lib/capacity";
import { AppError, fieldError, forbidden, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const secondParam = (params: unknown, key: string, label: string) =>
  idParam({ id: (params as Record<string, string | undefined>)[key] }, label);

/** Paid amount for each invoice (non-voided payments). */
const paidSql = sql<number>`coalesce((select sum(p.amount_cents) from payments p where p.invoice_id = i.id and p.voided_at is null), 0)::bigint`;

/** Totals for drafts are computed live from lines; issued/void-after-issue use the stored totals. */
const liveTotalSql = sql<number>`coalesce(i.total_cents, (
  select coalesce(sum(l.quantity * l.unit_price_cents - l.discount_cents), 0)
       + round(coalesce(sum(l.quantity * l.unit_price_cents - l.discount_cents) filter (where l.taxable), 0) * i.tax_rate_bps / 10000.0)
    from invoice_lines l where l.invoice_id = i.id))::bigint`;

export async function loadInvoice(trx: Tx, id: string) {
  const inv = await trx.selectFrom("invoices as i")
    .innerJoin("customers as c", "c.id", "i.customerId")
    .innerJoin("locations as l", "l.id", "i.locationId")
    .select(["i.id", "i.status", "i.number", "i.taxRateBps", "i.notes", "i.reservationId", "i.customerId", "i.locationId",
      "i.createdAt", "i.issuedAt", "i.voidedAt", "i.voidReason", "i.subtotalCents", "i.discountCents", "i.taxCents", "i.totalCents",
      "c.firstName", "c.lastName", "c.email", "c.phone", "l.name as locationName", "l.taxRateBps as locationTaxRateBps"])
    .where("i.id", "=", id).executeTakeFirst();
  if (!inv) throw notFound("Invoice");
  const [lines, payments] = await Promise.all([
    trx.selectFrom("invoiceLines").select(["id", "serviceId", "description", "quantity", "unitPriceCents", "discountCents", "taxable", "position"])
      .where("invoiceId", "=", id).orderBy("position").orderBy("createdAt").execute(),
    trx.selectFrom("payments as p").innerJoin("users as u", "u.id", "p.recordedByUserId")
      .select(["p.id", "p.amountCents", "p.method", "p.reference", "p.receivedAt", "p.voidedAt", "p.voidReason"])
      .select(sql<string>`u.first_name || ' ' || u.last_name`.as("recordedBy"))
      .where("p.invoiceId", "=", id).orderBy("p.receivedAt").execute(),
  ]);
  // Drafts are priced at the location's current rate; issued invoices keep the rate they were issued with.
  const rate = inv.status === "draft" ? inv.locationTaxRateBps : inv.taxRateBps;
  const totals = inv.totalCents !== null
    ? { subtotalCents: inv.subtotalCents!, discountCents: inv.discountCents!, taxCents: inv.taxCents!, totalCents: inv.totalCents,
        taxableCents: lines.filter((l) => l.taxable).reduce((n, l) => n + l.quantity * l.unitPriceCents - l.discountCents, 0) }
    : invoiceTotals(lines, rate);
  const paidCents = payments.filter((p) => !p.voidedAt).reduce((n, p) => n + p.amountCents, 0);
  const balanceCents = inv.status === "issued" ? totals.totalCents - paidCents : 0;
  const { firstName, lastName, email, phone, locationName, locationTaxRateBps: _l, subtotalCents: _s, discountCents: _d, taxCents: _t, totalCents: _tt, ...rest } = inv;
  return {
    ...rest,
    taxRateBps: rate,
    customer: { id: inv.customerId, firstName, lastName, email, phone },
    location: { id: inv.locationId, name: locationName },
    lines: lines.map((l) => ({ ...l, amountCents: l.quantity * l.unitPriceCents - l.discountCents })),
    payments,
    totals,
    paidCents,
    balanceCents,
    paymentStatus: inv.status !== "issued" ? inv.status : balanceCents <= 0 ? "paid" : paidCents > 0 ? "partially_paid" : "unpaid",
  };
}

async function draftInvoice(trx: Tx, id: string) {
  const inv = await trx.selectFrom("invoices").select(["id", "status"]).where("id", "=", id).forUpdate().executeTakeFirst();
  if (!inv) throw notFound("Invoice");
  if (inv.status !== "draft") throw new AppError(409, "not_draft", "Only draft invoices can be changed. Void and re-create it if it's wrong.");
  return inv;
}

async function createDraft(trx: Tx, auth: AuthContext, args: { customerId: string; locationId: string; reservationId?: string; notes?: string | null }) {
  const [customer, location] = await Promise.all([
    trx.selectFrom("customers").select(["id", "archivedAt"]).where("id", "=", args.customerId).executeTakeFirst(),
    trx.selectFrom("locations").select(["id", "taxRateBps"]).where("id", "=", args.locationId).executeTakeFirst(),
  ]);
  if (!customer) throw new AppError(422, "invalid_reference", "That customer was not found.");
  if (!location) throw new AppError(422, "invalid_reference", "That location was not found.");
  const row = await trx.insertInto("invoices").values({
    organizationId: auth.orgId, customerId: customer.id, locationId: location.id, reservationId: args.reservationId ?? null,
    taxRateBps: location.taxRateBps, notes: args.notes ?? null, createdByUserId: auth.userId,
  }).returning("id").executeTakeFirstOrThrow();
  await recordAudit(trx, auth, { action: "invoice.created", entityType: "invoice", entityId: row.id,
    changes: { customerId: customer.id, ...(args.reservationId && { reservationId: args.reservationId }) } });
  return row.id;
}

const listQuery = z.object({
  status: z.enum(["draft", "unpaid", "paid", "void"]).optional(),
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const billingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/invoices", { preHandler: app.authorize("billing:read") }, async (req) => {
    const q = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let query = trx.selectFrom("invoices as i").innerJoin("customers as c", "c.id", "i.customerId")
        .select(["i.id", "i.number", "i.status", "i.createdAt", "i.issuedAt", "i.customerId", "i.reservationId"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .select(liveTotalSql.as("totalCents"))
        .select(paidSql.as("paidCents"));
      if (q.customerId) query = query.where("i.customerId", "=", q.customerId);
      if (q.status === "draft" || q.status === "void") query = query.where("i.status", "=", q.status);
      if (q.status === "unpaid") query = query.where("i.status", "=", "issued").where(sql<boolean>`${paidSql} < i.total_cents`);
      if (q.status === "paid") query = query.where("i.status", "=", "issued").where(sql<boolean>`${paidSql} >= i.total_cents`);
      const items = await query.orderBy("i.createdAt", "desc").limit(q.limit).execute();
      return { items: items.map((i) => ({ ...i, balanceCents: i.status === "issued" ? Number(i.totalCents) - Number(i.paidCents) : 0 })) };
    });
  });

  app.get("/invoices/:id", { preHandler: app.authorize("billing:read") }, async (req) => {
    const id = idParam(req.params, "Invoice");
    return withTenant(app.db, req.auth, (trx) => loadInvoice(trx, id));
  });

  app.post("/invoices", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const input = invoiceCreateInput.parse(req.body);
    const inv = await withTenant(app.db, req.auth, async (trx) => loadInvoice(trx, await createDraft(trx, req.auth, input)));
    return reply.status(201).send(inv);
  });

  /** Draft an invoice for a reservation with the stay priced at the rate locked in at booking. */
  app.post("/reservations/:id/invoice", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const reservationId = idParam(req.params, "Reservation");
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations as r").innerJoin("services as s", "s.id", "r.serviceId")
        .select(["r.id", "r.customerId", "r.locationId", "r.status", "r.startsAt", "r.endsAt", "r.unitPriceCents", "r.priceUnit",
          "r.serviceId", "s.name as serviceName", "s.isTaxable"])
        .where("r.id", "=", reservationId).forUpdate().executeTakeFirst();
      if (!r) throw notFound("Reservation");
      if (r.status === "cancelled" || r.status === "no_show") {
        throw new AppError(409, "not_billable", "Cancelled and no-show reservations can't be invoiced from here. Create a manual invoice for any fee.");
      }
      const existing = await trx.selectFrom("invoices").select("id").where("reservationId", "=", reservationId).where("status", "<>", "void").executeTakeFirst();
      if (existing) throw new AppError(409, "invoice_exists", "This reservation already has an invoice.", { invoiceId: existing.id });
      const pets = await trx.selectFrom("reservationPets as rp").innerJoin("pets as p", "p.id", "rp.petId")
        .select("p.name").where("rp.reservationId", "=", reservationId).orderBy("p.name").execute();
      const est = estimateReservation({
        unit: r.priceUnit as PriceUnit, unitPriceCents: r.unitPriceCents, startsAt: r.startsAt, endsAt: r.endsAt,
        petCount: pets.length, timeZone: await locationTimezone(trx, r.locationId),
      });
      const unitWord = PRICE_UNIT_LABELS[r.priceUnit as PriceUnit].replace("per ", "");
      const id = await createDraft(trx, req.auth, { customerId: r.customerId, locationId: r.locationId, reservationId });
      await trx.insertInto("invoiceLines").values({
        organizationId: req.auth.orgId, invoiceId: id, serviceId: r.serviceId, taxable: r.isTaxable,
        description: `${r.serviceName} — ${pets.map((p) => p.name).join(", ")} (${est.quantity} ${unitWord}${est.quantity === 1 ? "" : "s"}${pets.length > 1 ? ` × ${pets.length} pets` : ""})`,
        quantity: est.quantity * est.petCount, unitPriceCents: r.unitPriceCents,
      }).execute();
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  app.post("/invoices/:id/lines", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const id = idParam(req.params, "Invoice");
    const input = invoiceLineInput.parse(req.body);
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      await draftInvoice(trx, id);
      let description = input.description, unitPriceCents = input.unitPriceCents, taxable = input.taxable;
      if (input.serviceId) {
        const svc = await trx.selectFrom("services").select(["name", "priceCents", "isTaxable"]).where("id", "=", input.serviceId).executeTakeFirst();
        if (!svc) throw new AppError(422, "invalid_reference", "That service was not found.");
        description ??= svc.name; unitPriceCents ??= svc.priceCents; taxable ??= svc.isTaxable;
      }
      if (!description) throw fieldError("description", "Description is required");
      if (unitPriceCents === undefined) throw fieldError("unitPriceCents", "Price is required");
      if (input.discountCents > input.quantity * unitPriceCents) throw fieldError("discountCents", "Discount can't be more than the line amount");
      const pos = await trx.selectFrom("invoiceLines").select((eb) => eb.fn.max("position").as("p")).where("invoiceId", "=", id).executeTakeFirst();
      await trx.insertInto("invoiceLines").values({
        organizationId: req.auth.orgId, invoiceId: id, serviceId: input.serviceId ?? null, description, quantity: input.quantity,
        unitPriceCents, discountCents: input.discountCents, taxable: taxable ?? false, position: Number(pos?.p ?? 0) + 1,
      }).execute();
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  app.delete("/invoices/:id/lines/:lineId", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Invoice");
    const lineId = secondParam(req.params, "lineId", "Invoice line");
    return withTenant(app.db, req.auth, async (trx) => {
      await draftInvoice(trx, id);
      const res = await trx.deleteFrom("invoiceLines").where("id", "=", lineId).where("invoiceId", "=", id).executeTakeFirst();
      if (res.numDeletedRows === 0n) throw notFound("Invoice line");
      return loadInvoice(trx, id);
    });
  });

  /** Issue: lock the tax rate and totals and assign the next invoice number. */
  app.post("/invoices/:id/issue", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Invoice");
    return withTenant(app.db, req.auth, async (trx) => {
      await draftInvoice(trx, id);
      const inv = await trx.selectFrom("invoices as i").innerJoin("locations as l", "l.id", "i.locationId")
        .select(["l.taxRateBps"]).where("i.id", "=", id).executeTakeFirstOrThrow();
      const lines = await trx.selectFrom("invoiceLines").select(["quantity", "unitPriceCents", "discountCents", "taxable"]).where("invoiceId", "=", id).execute();
      if (lines.length === 0) throw new AppError(409, "empty_invoice", "Add at least one line before issuing the invoice.");
      const t = invoiceTotals(lines, inv.taxRateBps);
      await trx.insertInto("invoiceCounters").values({ organizationId: req.auth.orgId }).onConflict((oc) => oc.column("organizationId").doNothing()).execute();
      const { lastNumber } = await trx.updateTable("invoiceCounters").set((eb) => ({ lastNumber: eb("lastNumber", "+", 1) }))
        .where("organizationId", "=", req.auth.orgId).returning("lastNumber").executeTakeFirstOrThrow();
      await trx.updateTable("invoices").set({
        status: "issued", number: lastNumber, taxRateBps: inv.taxRateBps, issuedAt: new Date(), issuedByUserId: req.auth.userId,
        subtotalCents: t.subtotalCents, discountCents: t.discountCents, taxCents: t.taxCents, totalCents: t.totalCents,
      }).where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: "invoice.issued", entityType: "invoice", entityId: id,
        changes: { number: lastNumber, totalCents: t.totalCents, taxCents: t.taxCents, taxRateBps: inv.taxRateBps } });
      return loadInvoice(trx, id);
    });
  });

  app.post("/invoices/:id/void", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Invoice");
    const { reason } = invoiceVoidInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const inv = await trx.selectFrom("invoices").select(["status", "number"]).where("id", "=", id).forUpdate().executeTakeFirst();
      if (!inv) throw notFound("Invoice");
      if (inv.status === "void") throw new AppError(409, "already_void", "This invoice is already void.");
      if (inv.status === "issued") {
        if (!req.auth.permissions.has("billing:refund")) throw forbidden();
        const paid = await trx.selectFrom("payments").select("id").where("invoiceId", "=", id).where("voidedAt", "is", null).executeTakeFirst();
        if (paid) throw new AppError(409, "has_payments", "This invoice has payments. Void the payments first (or issue a refund once refunds are available).");
      }
      await trx.updateTable("invoices").set({ status: "void", voidedAt: new Date(), voidedByUserId: req.auth.userId, voidReason: reason }).where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: "invoice.voided", entityType: "invoice", entityId: id, changes: { reason, from: inv.status, number: inv.number } });
      return loadInvoice(trx, id);
    });
  });

  app.post("/invoices/:id/payments", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const id = idParam(req.params, "Invoice");
    const input = paymentInput.parse(req.body);
    const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
    if (receivedAt.getTime() > Date.now() + 5 * 60_000) throw fieldError("receivedAt", "That date is in the future");
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      const locked = await trx.selectFrom("invoices").select(["status", "customerId", "totalCents"]).where("id", "=", id).forUpdate().executeTakeFirst();
      if (!locked) throw notFound("Invoice");
      if (locked.status !== "issued") throw new AppError(409, "not_issued", "Issue the invoice before recording a payment.");
      const current = await loadInvoice(trx, id);
      if (input.amountCents > current.balanceCents) {
        throw fieldError("amountCents", `That's more than the balance due (${formatMoney(current.balanceCents)}). Account credit isn't available yet.`);
      }
      const row = await trx.insertInto("payments").values({
        organizationId: req.auth.orgId, customerId: locked.customerId, invoiceId: id, amountCents: input.amountCents,
        method: input.method, reference: input.reference, receivedAt, recordedByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "payment.recorded", entityType: "invoice", entityId: id,
        changes: { paymentId: row.id, amountCents: input.amountCents, method: input.method } });
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  app.post("/payments/:id/void", { preHandler: app.authorize("billing:refund") }, async (req) => {
    const id = idParam(req.params, "Payment");
    const { reason } = invoiceVoidInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const row = await trx.updateTable("payments").set({ voidedAt: new Date(), voidedByUserId: req.auth.userId, voidReason: reason })
        .where("id", "=", id).where("voidedAt", "is", null).returning(["invoiceId", "amountCents"]).executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "That payment was not found or is already void.");
      await recordAudit(trx, req.auth, { action: "payment.voided", entityType: "invoice", entityId: row.invoiceId,
        changes: { paymentId: id, amountCents: row.amountCents, reason } });
      return loadInvoice(trx, row.invoiceId);
    });
  });
};

/** Outstanding balance for customers (issued invoice totals minus active payments). */
export async function customerBalance(trx: Tx, customerId: string): Promise<number> {
  const row = await sql<{ balance: number }>`
    select coalesce(sum(i.total_cents - ${paidSql}), 0)::bigint as balance
      from invoices i where i.customer_id = ${customerId} and i.status = 'issued'`.execute(trx);
  return Number(row.rows[0]?.balance ?? 0);
}
