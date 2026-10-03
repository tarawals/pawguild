/**
 * Memberships: a monthly fee with included daycare days. Billed on the sign-up date at full price
 * (no proration), then on the same day each month. Unused days don't roll over. Cancelling ends the
 * membership on the last day of the paid month. There are no card payments in the app, so each
 * month's invoice is issued for staff to collect; renewals are billed with "Bill due memberships"
 * (idempotent: one period per month, enforced by a unique key).
 */
import {
  calendarDate, duePeriods, membershipCancelInput, membershipPeriod, membershipPlanInput, membershipPlanUpdateInput, membershipSignupInput,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { diff, recordAudit } from "../lib/audit";
import { AppError, fieldError, notFound } from "../lib/errors";
import { locationTimezone } from "../lib/hours";
import { membershipPeriodBalances } from "../lib/packages";
import { idParam } from "../lib/params";
import { createDraft, issueInvoice } from "./billing";

const PLAN_COLUMNS = ["id", "name", "covers", "daysPerMonth", "priceCents", "isTaxable", "isActive"] as const;
const listQuery = z.object({ includeInactive: z.enum(["true", "false"]).optional() });
const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

type MembershipRow = {
  id: string; customerId: string; locationId: string; name: string; covers: string; daysPerMonth: number; priceCents: number;
  isTaxable: boolean; startedOn: string; endsOn: string | null; cancelledAt: Date | null;
};

async function today(trx: Tx, orgId: string, locationId: string) {
  return calendarDate(new Date(), await locationTimezone(trx, locationId, orgId));
}

/** Bill every month that's due for one membership; returns the periods created. */
async function billDue(trx: Tx, auth: AuthContext, m: MembershipRow) {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`membership:${m.id}`}, 0))`.execute(trx);
  const billed = Number((await trx.selectFrom("membershipPeriods").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("customerMembershipId", "=", m.id).executeTakeFirstOrThrow()).n);
  // Cancelled before the first bill: nothing is ever billed.
  if (billed === 0 && m.cancelledAt) return [];
  const due = duePeriods(m.startedOn, billed, await today(trx, auth.orgId, m.locationId), m.endsOn);
  const created: { periodStart: string; periodEnd: string; invoiceId: string }[] = [];
  for (const p of due) {
    const invoiceId = await createDraft(trx, auth, { customerId: m.customerId, locationId: m.locationId });
    const kind = m.covers === "full_day" ? "full" : "half";
    await trx.insertInto("invoiceLines").values({
      organizationId: auth.orgId, invoiceId, serviceId: null, quantity: 1, unitPriceCents: m.priceCents, discountCents: 0, taxable: m.isTaxable, position: 0,
      description: `${m.name} membership — ${m.daysPerMonth} ${kind} day${m.daysPerMonth === 1 ? "" : "s"} of daycare, ${fmt(p.start)} – ${fmt(p.end)}`,
    }).execute();
    await issueInvoice(trx, auth, invoiceId);
    await trx.insertInto("membershipPeriods").values({
      organizationId: auth.orgId, customerMembershipId: m.id, periodStart: p.start, periodEnd: p.end, days: m.daysPerMonth, invoiceId,
    }).execute();
    await recordAudit(trx, auth, { action: "membership.billed", entityType: "customer", entityId: m.customerId,
      changes: { membershipId: m.id, periodStart: p.start, periodEnd: p.end, invoiceId, priceCents: m.priceCents } });
    created.push({ periodStart: p.start, periodEnd: p.end, invoiceId });
  }
  return created;
}

const membershipColumns = ["id", "customerId", "locationId", "name", "covers", "daysPerMonth", "priceCents", "isTaxable", "startedOn", "endsOn", "cancelledAt"] as const;

/** A membership with its status, current month, next bill date and billed months. */
async function describeMembership(trx: Tx, orgId: string, m: MembershipRow & { cancelReason?: string | null }) {
  const t = await today(trx, orgId, m.locationId);
  const periods = await trx.selectFrom("membershipPeriods as mp").innerJoin("invoices as i", "i.id", "mp.invoiceId")
    .select(["mp.id", "mp.periodStart", "mp.periodEnd", "mp.days", "mp.invoiceId", "i.status as invoiceStatus"])
    .where("mp.customerMembershipId", "=", m.id).orderBy("mp.periodStart").execute();
  const balances = await membershipPeriodBalances(trx, m.customerId, t);
  const withLeft = periods.map((p) => ({ ...p, remaining: balances.find((b) => b.id === p.id)?.remaining ?? 0 }));
  const current = withLeft.find((p) => p.periodStart <= t && p.periodEnd >= t && p.invoiceStatus !== "void") ?? null;
  const ended = (m.endsOn !== null && m.endsOn < t) || (m.cancelledAt !== null && periods.length === 0);
  const next = membershipPeriod(m.startedOn, periods.length);
  const nextBillOn = ended || (m.endsOn !== null && next.start > m.endsOn) ? null : next.start;
  return {
    ...m, priceCents: Number(m.priceCents),
    status: ended ? "ended" : m.endsOn ? "ending" : m.startedOn > t ? "upcoming" : "active",
    current, nextBillOn, due: nextBillOn !== null && nextBillOn <= t,
    periods: withLeft,
  };
}

/** How many memberships have a month due to be billed. */
export async function countDueMemberships(trx: Tx, orgId: string): Promise<number> {
  const rows = await trx.selectFrom("customerMemberships").select([...membershipColumns]).execute();
  let due = 0;
  for (const m of rows) if ((await describeMembership(trx, orgId, m)).due) due++;
  return due;
}

export const membershipRoutes: FastifyPluginAsync = async (app) => {
  // ---- Plans (owners and administrators) ------------------------------------------------------
  app.get("/membership-plans", { preHandler: app.authorize("billing:read") }, async (req) => {
    const { includeInactive } = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("membershipPlans").select([...PLAN_COLUMNS]).orderBy("isActive", "desc").orderBy("name");
      if (includeInactive !== "true") q = q.where("isActive", "=", true);
      return { items: (await q.execute()).map((p) => ({ ...p, priceCents: Number(p.priceCents) })) };
    });
  });

  app.post("/membership-plans", { preHandler: app.authorize("settings:manage") }, async (req, reply) => {
    const input = membershipPlanInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      if (await trx.selectFrom("membershipPlans").select("id").where("name", "=", input.name).executeTakeFirst()) throw fieldError("name", "There's already a plan with this name");
      const row = await trx.insertInto("membershipPlans").values({ organizationId: req.auth.orgId, ...input }).returning([...PLAN_COLUMNS]).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "membership_plan.created", entityType: "membership_plan", entityId: row.id, changes: input });
      return { ...row, priceCents: Number(row.priceCents) };
    });
    return reply.status(201).send(created);
  });

  /** Changes apply to new sign-ups; existing members keep their terms. */
  app.patch("/membership-plans/:id", { preHandler: app.authorize("settings:manage") }, async (req) => {
    const id = idParam(req.params, "Plan");
    const input = membershipPlanUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("membershipPlans").select([...PLAN_COLUMNS]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!before) throw notFound("Plan");
      if (input.name && input.name !== before.name
        && await trx.selectFrom("membershipPlans").select("id").where("name", "=", input.name).where("id", "<>", id).executeTakeFirst()) {
        throw fieldError("name", "There's already a plan with this name");
      }
      if (Object.keys(input).length === 0) return { ...before, priceCents: Number(before.priceCents) };
      const after = await trx.updateTable("membershipPlans").set(input).where("id", "=", id).returning([...PLAN_COLUMNS]).executeTakeFirstOrThrow();
      const changes = diff({ ...before, priceCents: Number(before.priceCents) }, { ...after, priceCents: Number(after.priceCents) });
      if (Object.keys(changes).length) await recordAudit(trx, req.auth, { action: "membership_plan.updated", entityType: "membership_plan", entityId: id, changes });
      return { ...after, priceCents: Number(after.priceCents) };
    });
  });

  // ---- Customers' memberships -----------------------------------------------------------------
  app.get("/customers/:id/memberships", { preHandler: app.authorize("billing:read") }, async (req) => {
    const customerId = idParam(req.params, "Customer");
    return withTenant(app.db, req.auth, async (trx) => {
      if (!await trx.selectFrom("customers").select("id").where("id", "=", customerId).executeTakeFirst()) throw notFound("Customer");
      const rows = await trx.selectFrom("customerMemberships").select([...membershipColumns, "cancelReason"])
        .where("customerId", "=", customerId).orderBy("startedOn", "desc").execute();
      return { items: await Promise.all(rows.map((m) => describeMembership(trx, req.auth.orgId, m))) };
    });
  });

  /** Sign up. If it starts today (the default), the first month is billed now at full price. */
  app.post("/customers/:id/memberships", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const customerId = idParam(req.params, "Customer");
    const input = membershipSignupInput.parse(req.body);
    const result = await withTenant(app.db, req.auth, async (trx) => {
      const customer = await trx.selectFrom("customers").select(["id", "archivedAt"]).where("id", "=", customerId).executeTakeFirst();
      if (!customer || customer.archivedAt) throw notFound("Customer");
      const plan = await trx.selectFrom("membershipPlans").select([...PLAN_COLUMNS]).where("id", "=", input.planId).executeTakeFirst();
      if (!plan) throw fieldError("planId", "Choose a plan");
      if (!plan.isActive) throw fieldError("planId", "That plan is no longer offered");
      let lq = trx.selectFrom("locations").select("id").where("isActive", "=", true).orderBy("name");
      if (input.locationId) lq = lq.where("id", "=", input.locationId);
      const location = await lq.executeTakeFirst();
      if (!location) throw fieldError("locationId", "Choose a location");
      const t = await today(trx, req.auth.orgId, location.id);
      const startsOn = input.startsOn ?? t;
      if (startsOn < t) throw fieldError("startsOn", "A membership can't start in the past");
      const same = await trx.selectFrom("customerMemberships").select("id").where("customerId", "=", customerId).where("planId", "=", plan.id)
        .where((eb) => eb.or([eb("endsOn", "is", null), eb("endsOn", ">=", t)])).where("cancelledAt", "is", null).executeTakeFirst();
      if (same) throw new AppError(409, "already_member", `This customer already has the ${plan.name} membership.`);
      const row = await trx.insertInto("customerMemberships").values({
        organizationId: req.auth.orgId, customerId, planId: plan.id, locationId: location.id, name: plan.name, covers: plan.covers,
        daysPerMonth: plan.daysPerMonth, priceCents: Number(plan.priceCents), isTaxable: plan.isTaxable, startedOn: startsOn, createdByUserId: req.auth.userId,
      }).returning([...membershipColumns]).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "membership.started", entityType: "customer", entityId: customerId,
        changes: { membershipId: row.id, plan: plan.name, startsOn, priceCents: Number(plan.priceCents), daysPerMonth: plan.daysPerMonth } });
      const billed = await billDue(trx, req.auth, row);
      return { membership: await describeMembership(trx, req.auth.orgId, row), invoiceId: billed[0]?.invoiceId ?? null };
    });
    return reply.status(201).send(result);
  });

  /** Cancel: the membership ends on the last day of the paid month (or before it starts, if never billed). */
  app.post("/memberships/:id/cancel", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Membership");
    const { reason } = membershipCancelInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const m = await trx.selectFrom("customerMemberships").select([...membershipColumns]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!m) throw notFound("Membership");
      if (m.cancelledAt) throw new AppError(409, "already_cancelled", "This membership is already cancelled.");
      const last = await trx.selectFrom("membershipPeriods").select("periodEnd").where("customerMembershipId", "=", id).orderBy("periodStart", "desc").executeTakeFirst();
      const endsOn = last?.periodEnd ?? m.startedOn;
      await trx.updateTable("customerMemberships").set({ endsOn, cancelledAt: new Date(), cancelledByUserId: req.auth.userId, cancelReason: reason ?? null })
        .where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: "membership.cancelled", entityType: "customer", entityId: m.customerId,
        changes: { membershipId: id, endsOn, reason: reason ?? null, billed: Boolean(last) } });
      const after = await trx.selectFrom("customerMemberships").select([...membershipColumns, "cancelReason"]).where("id", "=", id).executeTakeFirstOrThrow();
      return describeMembership(trx, req.auth.orgId, after);
    });
  });

  /** Undo a cancellation before the membership has ended; billing continues as before. */
  app.post("/memberships/:id/reinstate", { preHandler: app.authorize("billing:write") }, async (req) => {
    const id = idParam(req.params, "Membership");
    return withTenant(app.db, req.auth, async (trx) => {
      const m = await trx.selectFrom("customerMemberships").select([...membershipColumns]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!m) throw notFound("Membership");
      if (!m.cancelledAt) throw new AppError(409, "not_cancelled", "This membership isn't cancelled.");
      if (m.endsOn && m.endsOn < await today(trx, req.auth.orgId, m.locationId)) {
        throw new AppError(409, "already_ended", "This membership has already ended. Sign the customer up again instead.");
      }
      await trx.updateTable("customerMemberships").set({ endsOn: null, cancelledAt: null, cancelledByUserId: null, cancelReason: null }).where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: "membership.reinstated", entityType: "customer", entityId: m.customerId, changes: { membershipId: id } });
      const after = await trx.selectFrom("customerMemberships").select([...membershipColumns, "cancelReason"]).where("id", "=", id).executeTakeFirstOrThrow();
      return describeMembership(trx, req.auth.orgId, after);
    });
  });

  /** All memberships, for the Memberships page. */
  app.get("/memberships", { preHandler: app.authorize("billing:read") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const rows = await trx.selectFrom("customerMemberships as m").innerJoin("customers as c", "c.id", "m.customerId")
        .select(membershipColumns.map((c) => `m.${c}` as const)).select("m.cancelReason")
        .select(sql<string>`c.last_name || ', ' || c.first_name`.as("customerName"))
        .orderBy("c.lastName").orderBy("c.firstName").orderBy("m.startedOn", "desc").execute();
      const items = await Promise.all(rows.map(async (r) => ({ ...(await describeMembership(trx, req.auth.orgId, r)), customerName: r.customerName })));
      return { items, dueCount: items.filter((i) => i.due).length };
    }));

  /** Bill every membership month that's due (each gets its own issued invoice). Safe to run again. */
  app.post("/memberships/bill-due", { preHandler: app.authorize("billing:write") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const rows = await trx.selectFrom("customerMemberships as m").innerJoin("customers as c", "c.id", "m.customerId")
        .select(membershipColumns.map((c) => `m.${c}` as const))
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName")).execute();
      const billed: { customerName: string; membership: string; periodStart: string; periodEnd: string; invoiceId: string }[] = [];
      for (const r of rows) {
        for (const p of await billDue(trx, req.auth, r)) billed.push({ customerName: r.customerName, membership: r.name, ...p });
      }
      return { billed };
    }));
};
