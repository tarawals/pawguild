import {
  creditApplyInput, creditNoteInput, creditReceiveInput, creditRefundInput, invoiceBalance, invoiceRefundInput,
  calendarDate, formatMoney, invoiceCreateInput, invoiceLineInput, invoiceTotals, invoiceVoidInput,
  paymentInput, PRICE_UNIT_LABELS, type PriceUnit,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { recordAudit } from "../lib/audit";
import { locationTimezone } from "../lib/capacity";
import { getBillingRules, priceReservation } from "../lib/billing-rules";
import { writeStayLines } from "../lib/packages";
import { AppError, fieldError, forbidden, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const secondParam = (params: unknown, key: string, label: string) =>
  idParam({ id: (params as Record<string, string | undefined>)[key] }, label);

/** Net paid on each invoice: non-voided payments minus refunds from that invoice. */
const paidSql = sql<number>`(coalesce((select sum(p.amount_cents) from payments p where p.invoice_id = i.id and p.voided_at is null), 0)
  - coalesce((select sum(r.amount_cents) from refunds r where r.invoice_id = i.id), 0))::bigint`;
const creditedSql = sql<number>`coalesce((select sum(c.amount_cents) from invoice_credit_notes c where c.invoice_id = i.id), 0)::bigint`;
/** Issued-invoice balance (negative = overpaid). */
const balanceSql = sql<number>`(i.total_cents - ${creditedSql} - ${paidSql})`;

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
  const [lines, payments, creditNotes, refunds, creditCents] = await Promise.all([
    trx.selectFrom("invoiceLines").select(["id", "serviceId", "description", "quantity", "unitPriceCents", "discountCents", "taxable", "position"])
      .where("invoiceId", "=", id).orderBy("position").orderBy("createdAt").execute(),
    trx.selectFrom("payments as p").innerJoin("users as u", "u.id", "p.recordedByUserId")
      .select(["p.id", "p.amountCents", "p.method", "p.reference", "p.receivedAt", "p.voidedAt", "p.voidReason"])
      .select(sql<string>`u.first_name || ' ' || u.last_name`.as("recordedBy"))
      .where("p.invoiceId", "=", id).orderBy("p.receivedAt").execute(),
    trx.selectFrom("invoiceCreditNotes as c").innerJoin("users as u", "u.id", "c.createdByUserId")
      .select(["c.id", "c.amountCents", "c.reason", "c.createdAt"])
      .select(sql<string>`u.first_name || ' ' || u.last_name`.as("createdBy"))
      .where("c.invoiceId", "=", id).orderBy("c.createdAt").execute(),
    trx.selectFrom("refunds as r").innerJoin("users as u", "u.id", "r.recordedByUserId")
      .select(["r.id", "r.amountCents", "r.method", "r.reference", "r.reason", "r.refundedAt"])
      .select(sql<string>`u.first_name || ' ' || u.last_name`.as("recordedBy"))
      .where("r.invoiceId", "=", id).orderBy("r.refundedAt").execute(),
    customerCredit(trx, inv.customerId),
  ]);
  // Drafts are priced at the location's current rate; issued invoices keep the rate they were issued with.
  const rate = inv.status === "draft" ? inv.locationTaxRateBps : inv.taxRateBps;
  const totals = inv.totalCents !== null
    ? { subtotalCents: inv.subtotalCents!, discountCents: inv.discountCents!, taxCents: inv.taxCents!, totalCents: inv.totalCents,
        taxableCents: lines.filter((l) => l.taxable).reduce((n, l) => n + l.quantity * l.unitPriceCents - l.discountCents, 0) }
    : invoiceTotals(lines, rate);
  const paymentsCents = payments.filter((p) => !p.voidedAt).reduce((n, p) => n + p.amountCents, 0);
  const refundsCents = refunds.reduce((n, r) => n + r.amountCents, 0);
  const creditNotesCents = creditNotes.reduce((n, c) => n + c.amountCents, 0);
  const paidCents = paymentsCents - refundsCents;
  const balanceCents = inv.status === "issued"
    ? invoiceBalance({ totalCents: totals.totalCents, creditNotesCents, paymentsCents, refundsCents })
    : 0;
  const { firstName, lastName, email, phone, locationName, locationTaxRateBps: _l, subtotalCents: _s, discountCents: _d, taxCents: _t, totalCents: _tt, ...rest } = inv;
  return {
    ...rest,
    taxRateBps: rate,
    customer: { id: inv.customerId, firstName, lastName, email, phone },
    location: { id: inv.locationId, name: locationName },
    lines: lines.map((l) => ({ ...l, amountCents: l.quantity * l.unitPriceCents - l.discountCents })),
    payments,
    creditNotes,
    refunds,
    totals,
    creditNotesCents,
    refundsCents,
    paidCents,
    balanceCents,
    /** The customer's available account credit (for "apply credit"). */
    customerCreditCents: creditCents,
    paymentStatus: inv.status !== "issued" ? inv.status
      : balanceCents < 0 ? "overpaid" : balanceCents === 0 ? "paid" : paidCents > 0 ? "partially_paid" : "unpaid",
  };
}

async function draftInvoice(trx: Tx, id: string) {
  const inv = await trx.selectFrom("invoices").select(["id", "status"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
  if (!inv) throw notFound("Invoice");
  if (inv.status !== "draft") throw new AppError(409, "not_draft", "Only draft invoices can be changed. Void and re-create it if it's wrong.");
  return inv;
}

/** Number the draft, fix its totals and mark it issued. */
export async function issueInvoice(trx: Tx, auth: AuthContext, id: string) {
  await draftInvoice(trx, id);
  const inv = await trx.selectFrom("invoices as i").innerJoin("locations as l", "l.id", "i.locationId")
    .select(["l.taxRateBps"]).where("i.id", "=", id).executeTakeFirstOrThrow();
  const lines = await trx.selectFrom("invoiceLines").select(["quantity", "unitPriceCents", "discountCents", "taxable"]).where("invoiceId", "=", id).execute();
  if (lines.length === 0) throw new AppError(409, "empty_invoice", "Add at least one line before issuing the invoice.");
  const t = invoiceTotals(lines, inv.taxRateBps);
  await trx.insertInto("invoiceCounters").values({ organizationId: auth.orgId }).onConflict((oc) => oc.column("organizationId").doNothing()).execute();
  const { lastNumber } = await trx.updateTable("invoiceCounters").set((eb) => ({ lastNumber: eb("lastNumber", "+", 1) }))
    .where("organizationId", "=", auth.orgId).returning("lastNumber").executeTakeFirstOrThrow();
  await trx.updateTable("invoices").set({
    status: "issued", number: lastNumber, taxRateBps: inv.taxRateBps, issuedAt: new Date(), issuedByUserId: auth.userId,
    subtotalCents: t.subtotalCents, discountCents: t.discountCents, taxCents: t.taxCents, totalCents: t.totalCents,
  }).where("id", "=", id).execute();
  await recordAudit(trx, auth, { action: "invoice.issued", entityType: "invoice", entityId: id,
    changes: { number: lastNumber, totalCents: t.totalCents, taxCents: t.taxCents, taxRateBps: inv.taxRateBps } });
}

export async function createDraft(trx: Tx, auth: AuthContext, args: { customerId: string; locationId: string; reservationId?: string; notes?: string | null }) {
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
  status: z.enum(["draft", "unpaid", "paid", "overpaid", "void"]).optional(),
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
        .select(paidSql.as("paidCents"))
        .select(sql<number>`case when i.status = 'issued' then ${balanceSql} else 0 end`.as("balanceCents"));
      if (q.customerId) query = query.where("i.customerId", "=", q.customerId);
      if (q.status === "draft" || q.status === "void") query = query.where("i.status", "=", q.status);
      if (q.status === "unpaid") query = query.where("i.status", "=", "issued").where(sql<boolean>`${balanceSql} > 0`);
      if (q.status === "paid") query = query.where("i.status", "=", "issued").where(sql<boolean>`${balanceSql} = 0`);
      if (q.status === "overpaid") query = query.where("i.status", "=", "issued").where(sql<boolean>`${balanceSql} < 0`);
      const items = await query.orderBy("i.createdAt", "desc").limit(q.limit).execute();
      return { items: items.map((i) => ({ ...i, totalCents: Number(i.totalCents), paidCents: Number(i.paidCents), balanceCents: Number(i.balanceCents) })) };
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
        .where("r.id", "=", reservationId).forNoKeyUpdate("r").executeTakeFirst(); // only the reservation: locking the service too could deadlock with bookings
      if (!r) throw notFound("Reservation");
      if (r.status === "cancelled" || r.status === "no_show") {
        throw new AppError(409, "not_billable", "Cancelled and no-show reservations can't be invoiced from here. Create a manual invoice for any fee.");
      }
      const existing = await trx.selectFrom("invoices").select("id").where("reservationId", "=", reservationId).where("status", "<>", "void").executeTakeFirst();
      if (existing) throw new AppError(409, "invoice_exists", "This reservation already has an invoice.", { invoiceId: existing.id });
      const pets = await trx.selectFrom("reservationPets as rp").innerJoin("pets as p", "p.id", "rp.petId")
        .select("p.name").where("rp.reservationId", "=", reservationId).orderBy("p.name").execute();
      const priced = await priceReservation(trx, req.auth.orgId, {
        serviceId: r.serviceId, unitPriceCents: r.unitPriceCents, priceUnit: r.priceUnit, startsAt: r.startsAt, endsAt: r.endsAt,
        petCount: pets.length, timeZone: await locationTimezone(trx, r.locationId),
      });
      const id = await createDraft(trx, req.auth, { customerId: r.customerId, locationId: r.locationId, reservationId });
      const tz = await locationTimezone(trx, r.locationId);
      await writeStayLines(trx, req.auth, {
        invoiceId: id, reservationId, customerId: r.customerId, petNames: pets.map((p) => p.name), priced,
        additionalPetDiscountBps: (await getBillingRules(trx, req.auth.orgId)).additionalPetDiscountBps, today: calendarDate(new Date(), tz),
      });
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
      await issueInvoice(trx, req.auth, id);
      return loadInvoice(trx, id);
    });
  });

  app.post("/invoices/:id/void", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Invoice");
    const { reason } = invoiceVoidInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const inv = await trx.selectFrom("invoices").select(["status", "number"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!inv) throw notFound("Invoice");
      if (inv.status === "void") throw new AppError(409, "already_void", "This invoice is already void.");
      // A package sold on this invoice can't be voided once some of its days have been used.
      const usedPackage = await trx.selectFrom("customerPackages as cp")
        .innerJoin("packageRedemptions as r", "r.customerPackageId", "cp.id").innerJoin("invoices as ri", "ri.id", "r.invoiceId")
        .select("cp.name").where("cp.invoiceId", "=", id).where("ri.status", "<>", "void").executeTakeFirst();
      if (usedPackage) {
        throw new AppError(409, "package_in_use", `This invoice sold the package "${usedPackage.name}", and some of its days have been used. Void the invoices that used them first, or add a credit note instead.`);
      }
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
      const locked = await trx.selectFrom("invoices").select(["status", "customerId", "totalCents"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
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
      const current = await trx.selectFrom("payments").select(["invoiceId"]).where("id", "=", id).executeTakeFirst();
      if (current) {
        await trx.selectFrom("invoices").select("id").where("id", "=", current.invoiceId).forNoKeyUpdate().execute();
        const refunded = await trx.selectFrom("refunds").select("id").where("invoiceId", "=", current.invoiceId).executeTakeFirst();
        if (refunded) throw new AppError(409, "has_refunds", "This invoice has refunds, so its payments can't be voided. Use a credit note or refund instead.");
      }
      const row = await trx.updateTable("payments").set({ voidedAt: new Date(), voidedByUserId: req.auth.userId, voidReason: reason })
        .where("id", "=", id).where("voidedAt", "is", null).returning(["invoiceId", "amountCents", "method", "customerId"]).executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "That payment was not found or is already void.");
      if (row.method === "account_credit") {
        // Voiding a payment made from account credit gives the credit back.
        await trx.insertInto("accountCredits").values({
          organizationId: req.auth.orgId, customerId: row.customerId, amountCents: row.amountCents, kind: "reversal",
          paymentId: id, invoiceId: row.invoiceId, note: reason, createdByUserId: req.auth.userId,
        }).execute();
      }
      await recordAudit(trx, req.auth, { action: "payment.voided", entityType: "invoice", entityId: row.invoiceId,
        changes: { paymentId: id, amountCents: row.amountCents, reason } });
      return loadInvoice(trx, row.invoiceId);
    });
  });

  // ---- Credit notes and refunds on an invoice -------------------------------------------

  app.post("/invoices/:id/credit-notes", { preHandler: app.authorize("billing:refund") }, async (req, reply) => {
    const id = idParam(req.params, "Invoice");
    const input = creditNoteInput.parse(req.body);
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      const current = await trx.selectFrom("invoices").select(["status", "customerId", "totalCents"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!current) throw notFound("Invoice");
      if (current.status !== "issued") throw new AppError(409, "not_issued", "Credit notes can only be added to an issued invoice.");
      const loaded = await loadInvoice(trx, id);
      const creditable = loaded.totals.totalCents - loaded.creditNotesCents;
      if (input.amountCents > creditable) throw fieldError("amountCents", `That's more than can be credited (${formatMoney(creditable)}).`);
      const row = await trx.insertInto("invoiceCreditNotes").values({
        organizationId: req.auth.orgId, invoiceId: id, customerId: current.customerId, amountCents: input.amountCents,
        reason: input.reason, createdByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "invoice.credited", entityType: "invoice", entityId: id,
        changes: { creditNoteId: row.id, amountCents: input.amountCents, reason: input.reason } });
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  /** Refund an invoice overpayment to the customer, or move it onto their account credit. */
  app.post("/invoices/:id/refunds", { preHandler: app.authorize("billing:refund") }, async (req, reply) => {
    const id = idParam(req.params, "Invoice");
    const input = invoiceRefundInput.parse(req.body);
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      const current = await trx.selectFrom("invoices").select(["status", "customerId"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!current) throw notFound("Invoice");
      if (current.status !== "issued") throw new AppError(409, "not_issued", "Refunds can only be made against an issued invoice.");
      const loaded = await loadInvoice(trx, id);
      const overpaid = -loaded.balanceCents;
      if (overpaid <= 0) throw new AppError(409, "not_overpaid", "Nothing is owed back on this invoice. Add a credit note first if the customer should pay less.");
      if (input.amountCents > overpaid) throw fieldError("amountCents", `That's more than was overpaid (${formatMoney(overpaid)}).`);
      const refund = await trx.insertInto("refunds").values({
        organizationId: req.auth.orgId, customerId: current.customerId, invoiceId: id, amountCents: input.amountCents,
        method: input.method, reference: input.reference, reason: input.reason, refundedAt: new Date(), recordedByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      if (input.method === "account_credit") {
        await trx.insertInto("accountCredits").values({
          organizationId: req.auth.orgId, customerId: current.customerId, amountCents: input.amountCents, kind: "from_invoice",
          invoiceId: id, refundId: refund.id, note: input.reason, createdByUserId: req.auth.userId,
        }).execute();
      }
      await recordAudit(trx, req.auth, { action: input.method === "account_credit" ? "invoice.overpayment_to_credit" : "invoice.refunded",
        entityType: "invoice", entityId: id, changes: { refundId: refund.id, amountCents: input.amountCents, method: input.method, reason: input.reason } });
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  app.post("/invoices/:id/apply-credit", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const id = idParam(req.params, "Invoice");
    const { amountCents } = creditApplyInput.parse(req.body);
    const inv = await withTenant(app.db, req.auth, async (trx) => {
      const current = await trx.selectFrom("invoices").select(["status", "customerId"]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!current) throw notFound("Invoice");
      if (current.status !== "issued") throw new AppError(409, "not_issued", "Issue the invoice before applying credit.");
      await trx.selectFrom("customers").select("id").where("id", "=", current.customerId).forNoKeyUpdate().execute();
      const loaded = await loadInvoice(trx, id);
      if (amountCents > loaded.balanceCents) throw fieldError("amountCents", `That's more than the balance due (${formatMoney(Math.max(0, loaded.balanceCents))}).`);
      if (amountCents > loaded.customerCreditCents) throw fieldError("amountCents", `The customer only has ${formatMoney(loaded.customerCreditCents)} of account credit.`);
      const payment = await trx.insertInto("payments").values({
        organizationId: req.auth.orgId, customerId: current.customerId, invoiceId: id, amountCents, method: "account_credit",
        reference: "Account credit", receivedAt: new Date(), recordedByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("accountCredits").values({
        organizationId: req.auth.orgId, customerId: current.customerId, amountCents: -amountCents, kind: "applied",
        invoiceId: id, paymentId: payment.id, createdByUserId: req.auth.userId,
      }).execute();
      await recordAudit(trx, req.auth, { action: "invoice.credit_applied", entityType: "invoice", entityId: id,
        changes: { paymentId: payment.id, amountCents } });
      return loadInvoice(trx, id);
    });
    return reply.status(201).send(inv);
  });

  // ---- Customer account credit ----------------------------------------------------------

  app.get("/customers/:id/credits", { preHandler: app.authorize("billing:read") }, async (req) => {
    const customerId = idParam(req.params, "Customer");
    return withTenant(app.db, req.auth, async (trx) => {
      const c = await trx.selectFrom("customers").select("id").where("id", "=", customerId).executeTakeFirst();
      if (!c) throw notFound("Customer");
      const entries = await trx.selectFrom("accountCredits as a").innerJoin("users as u", "u.id", "a.createdByUserId")
        .leftJoin("invoices as i", "i.id", "a.invoiceId")
        .select(["a.id", "a.amountCents", "a.kind", "a.method", "a.reference", "a.note", "a.reservationId", "a.invoiceId", "a.createdAt", "i.number as invoiceNumber"])
        .select(sql<string>`u.first_name || ' ' || u.last_name`.as("recordedBy"))
        .where("a.customerId", "=", customerId).orderBy("a.createdAt", "desc").limit(100).execute();
      return { balanceCents: await customerCredit(trx, customerId), entries };
    });
  });

  /** Take money on account: a deposit for a reservation, or a prepayment. */
  app.post("/customers/:id/credits", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const customerId = idParam(req.params, "Customer");
    const input = creditReceiveInput.parse(req.body);
    const out = await withTenant(app.db, req.auth, async (trx) => {
      const c = await trx.selectFrom("customers").select("id").where("id", "=", customerId).executeTakeFirst();
      if (!c) throw notFound("Customer");
      if (input.reservationId) {
        const r = await trx.selectFrom("reservations").select("customerId").where("id", "=", input.reservationId).executeTakeFirst();
        if (!r || r.customerId !== customerId) throw new AppError(422, "invalid_reference", "That reservation isn't for this customer.");
      }
      const row = await trx.insertInto("accountCredits").values({
        organizationId: req.auth.orgId, customerId, amountCents: input.amountCents, kind: "received", method: input.method,
        reference: input.reference, note: input.note, reservationId: input.reservationId ?? null, createdByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: input.reservationId ? "credit.deposit_received" : "credit.received", entityType: "customer",
        entityId: customerId, changes: { creditId: row.id, amountCents: input.amountCents, method: input.method, reservationId: input.reservationId } });
      return { balanceCents: await customerCredit(trx, customerId) };
    });
    return reply.status(201).send(out);
  });

  /** Pay account credit back out to the customer (managers). */
  app.post("/customers/:id/credits/refund", { preHandler: app.authorize("billing:refund") }, async (req, reply) => {
    const customerId = idParam(req.params, "Customer");
    const input = creditRefundInput.parse(req.body);
    const out = await withTenant(app.db, req.auth, async (trx) => {
      const c = await trx.selectFrom("customers").select("id").where("id", "=", customerId).forNoKeyUpdate().executeTakeFirst();
      if (!c) throw notFound("Customer");
      const available = await customerCredit(trx, customerId);
      if (input.amountCents > available) throw fieldError("amountCents", `The customer only has ${formatMoney(available)} of account credit.`);
      const refund = await trx.insertInto("refunds").values({
        organizationId: req.auth.orgId, customerId, invoiceId: null, amountCents: input.amountCents, method: input.method,
        reference: input.reference, reason: input.reason, refundedAt: new Date(), recordedByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("accountCredits").values({
        organizationId: req.auth.orgId, customerId, amountCents: -input.amountCents, kind: "refunded", refundId: refund.id,
        note: input.reason, createdByUserId: req.auth.userId,
      }).execute();
      await recordAudit(trx, req.auth, { action: "credit.refunded", entityType: "customer", entityId: customerId,
        changes: { refundId: refund.id, amountCents: input.amountCents, method: input.method, reason: input.reason } });
      return { balanceCents: await customerCredit(trx, customerId) };
    });
    return reply.status(201).send(out);
  });
};

/** What a customer owes across issued invoices, and what they're owed back on overpaid invoices. */
export async function customerBalance(trx: Tx, customerId: string): Promise<{ owedCents: number; overpaidCents: number }> {
  const row = await sql<{ owed: number; overpaid: number }>`
    select coalesce(sum(greatest(b, 0)), 0)::bigint as owed, coalesce(sum(greatest(-b, 0)), 0)::bigint as overpaid
      from (select ${balanceSql} as b from invoices i where i.customer_id = ${customerId} and i.status = 'issued') x`.execute(trx);
  return { owedCents: Number(row.rows[0]?.owed ?? 0), overpaidCents: Number(row.rows[0]?.overpaid ?? 0) };
}

/** Available account credit (deposits, prepayments, overpayments moved to credit). */
export async function customerCredit(trx: Tx, customerId: string): Promise<number> {
  const row = await trx.selectFrom("accountCredits").select((eb) => eb.fn.sum<number>("amountCents").as("n"))
    .where("customerId", "=", customerId).executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Organization-wide totals for the dashboard. */
export async function billingSummary(trx: Tx) {
  // Note: CamelCasePlugin maps result columns, so overpaid_invoices arrives as overpaidInvoices.
  const row = await sql<{ owed: number; invoices: number; overpaidInvoices: number }>`
    select coalesce(sum(greatest(b, 0)), 0)::bigint as owed, count(*) filter (where b > 0)::int as invoices,
           count(*) filter (where b < 0)::int as overpaid_invoices
      from (select ${balanceSql} as b from invoices i where i.status = 'issued') x`.execute(trx);
  const r = row.rows[0]!;
  return { cents: Number(r.owed), invoices: r.invoices, overpaidInvoices: r.overpaidInvoices };
}
