/**
 * Reports. Everything is derived from the operational tables (no separate reporting store) and
 * grouped by the organization's local calendar date. Ranges are inclusive.
 *
 * Definitions:
 *  - Sales: invoices with status 'issued', by issue date. Drafts and void invoices are excluded.
 *    Net = line amounts after discounts; total = net + tax. Credit notes are reported by their own
 *    date (on invoices that are still issued) and reduce sales.
 *  - Payments: non-voided payments by received date. Payments made from account credit are listed
 *    separately and not counted as money collected (the money arrived as a deposit earlier).
 *    Net collected = payments (excluding credit) + deposits received - refunds paid out.
 *  - Occupancy: pets per day (daycare) / per night (boarding), counting pending, confirmed,
 *    checked-in and completed stays.
 */
import { daysCovered, reportRangeQuery } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { occupancy } from "../lib/capacity";

async function orgTimezone(trx: Tx, orgId: string) {
  return (await trx.selectFrom("organizations").select("timezone").where("id", "=", orgId).executeTakeFirstOrThrow()).timezone;
}
const n = (v: unknown) => Number(v ?? 0);

export const reportRoutes: FastifyPluginAsync = async (app) => {
  app.get("/sales", { preHandler: app.authorize("reports:read") }, async (req) => {
    const { from, to } = reportRangeQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      const tz = await orgTimezone(trx, req.auth.orgId);
      const issuedIn = sql`i.status = 'issued' and (i.issued_at at time zone ${tz})::date between ${from}::date and ${to}::date`;
      const [byService, totals, byMonth, credits, creditsByMonth] = await Promise.all([
        sql<{ service: string; category: string | null; quantity: number; grossCents: number; discountCents: number; netCents: number }>`
          select coalesce(s.name, 'Custom items') as service, s.category, sum(l.quantity)::int as quantity,
                 sum(l.quantity * l.unit_price_cents)::bigint as gross_cents, sum(l.discount_cents)::bigint as discount_cents,
                 sum(l.quantity * l.unit_price_cents - l.discount_cents)::bigint as net_cents
            from invoice_lines l join invoices i on i.id = l.invoice_id left join services s on s.id = l.service_id
           where ${issuedIn}
           group by s.id, s.name, s.category order by net_cents desc, service`.execute(trx),
        sql<{ invoices: number; subtotalCents: number; discountCents: number; taxCents: number; totalCents: number }>`
          select count(*)::int as invoices, coalesce(sum(i.subtotal_cents), 0)::bigint as subtotal_cents,
                 coalesce(sum(i.discount_cents), 0)::bigint as discount_cents, coalesce(sum(i.tax_cents), 0)::bigint as tax_cents,
                 coalesce(sum(i.total_cents), 0)::bigint as total_cents
            from invoices i where ${issuedIn}`.execute(trx),
        sql<{ month: string; invoices: number; netCents: number; taxCents: number }>`
          select to_char((i.issued_at at time zone ${tz})::date, 'YYYY-MM') as month, count(*)::int as invoices,
                 sum(i.subtotal_cents - i.discount_cents)::bigint as net_cents, sum(i.tax_cents)::bigint as tax_cents
            from invoices i where ${issuedIn} group by 1 order by 1`.execute(trx),
        sql<{ count: number; cents: number }>`
          select count(*)::int as count, coalesce(sum(c.amount_cents), 0)::bigint as cents
            from invoice_credit_notes c join invoices i on i.id = c.invoice_id
           where i.status = 'issued' and (c.created_at at time zone ${tz})::date between ${from}::date and ${to}::date`.execute(trx),
        sql<{ month: string; cents: number }>`
          select to_char((c.created_at at time zone ${tz})::date, 'YYYY-MM') as month, sum(c.amount_cents)::bigint as cents
            from invoice_credit_notes c join invoices i on i.id = c.invoice_id
           where i.status = 'issued' and (c.created_at at time zone ${tz})::date between ${from}::date and ${to}::date
           group by 1`.execute(trx),
      ]);
      const t = totals.rows[0]!;
      const creditMap = new Map(creditsByMonth.rows.map((c) => [c.month, n(c.cents)]));
      const months = [...new Set([...byMonth.rows.map((m) => m.month), ...creditMap.keys()])].sort();
      return {
        from, to, timeZone: tz,
        totals: {
          invoices: t.invoices, grossCents: n(t.subtotalCents), discountCents: n(t.discountCents),
          netCents: n(t.subtotalCents) - n(t.discountCents), taxCents: n(t.taxCents), invoicedCents: n(t.totalCents),
          creditNotesCents: n(credits.rows[0]!.cents), creditNotes: credits.rows[0]!.count,
          salesAfterCreditsCents: n(t.totalCents) - n(credits.rows[0]!.cents),
        },
        byService: byService.rows.map((r) => ({ ...r, grossCents: n(r.grossCents), discountCents: n(r.discountCents), netCents: n(r.netCents) })),
        byMonth: months.map((month) => {
          const m = byMonth.rows.find((x) => x.month === month);
          return { month, invoices: m?.invoices ?? 0, netCents: n(m?.netCents), taxCents: n(m?.taxCents), creditNotesCents: creditMap.get(month) ?? 0 };
        }),
      };
    });
  });

  app.get("/payments", { preHandler: app.authorize("reports:read") }, async (req) => {
    const { from, to } = reportRangeQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      const tz = await orgTimezone(trx, req.auth.orgId);
      const inRange = (col: string) => sql`(${sql.ref(col)} at time zone ${tz})::date between ${from}::date and ${to}::date`;
      const [payments, refunds, deposits] = await Promise.all([
        sql<{ method: string; count: number; cents: number }>`
          select p.method, count(*)::int as count, sum(p.amount_cents)::bigint as cents from payments p
           where p.voided_at is null and ${inRange("p.received_at")} group by p.method order by p.method`.execute(trx),
        sql<{ method: string; count: number; cents: number }>`
          select r.method, count(*)::int as count, sum(r.amount_cents)::bigint as cents from refunds r
           where ${inRange("r.refunded_at")} group by r.method order by r.method`.execute(trx),
        sql<{ method: string; count: number; cents: number }>`
          select a.method, count(*)::int as count, sum(a.amount_cents)::bigint as cents from account_credits a
           where a.kind = 'received' and ${inRange("a.created_at")} group by a.method order by a.method`.execute(trx),
      ]);
      const rows = (r: { rows: { method: string; count: number; cents: number }[] }) => r.rows.map((x) => ({ ...x, cents: n(x.cents) }));
      const p = rows(payments), rf = rows(refunds), d = rows(deposits);
      const sum = (xs: { cents: number }[]) => xs.reduce((a, x) => a + x.cents, 0);
      const moneyIn = p.filter((x) => x.method !== "account_credit");
      const moneyOut = rf.filter((x) => x.method !== "account_credit");
      return {
        from, to, timeZone: tz,
        payments: p, refunds: rf, deposits: d,
        totals: {
          paymentsCents: sum(moneyIn),
          creditAppliedCents: sum(p.filter((x) => x.method === "account_credit")),
          depositsCents: sum(d),
          refundsCents: sum(moneyOut),
          movedToCreditCents: sum(rf.filter((x) => x.method === "account_credit")),
          netCollectedCents: sum(moneyIn) + sum(d) - sum(moneyOut),
        },
        // Money in minus money out for each method (what should be in the drawer / card batch).
        byMethod: ["card", "cash", "check", "other"].map((method) => {
          const inn = sum(p.filter((x) => x.method === method)) + sum(d.filter((x) => x.method === method));
          const out = sum(rf.filter((x) => x.method === method));
          return { method, inCents: inn, outCents: out, netCents: inn - out };
        }).filter((m) => m.inCents || m.outCents),
      };
    });
  });

  /** Balances as of now (not date-ranged). */
  app.get("/balances", { preHandler: app.authorize("reports:read") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const rows = await sql<{ customerId: string; customerName: string; owedCents: number; overpaidCents: number; creditCents: number; oldestUnpaid: string | null }>`
        with bal as (
          select i.customer_id, i.issued_at,
                 i.total_cents
                 - coalesce((select sum(c.amount_cents) from invoice_credit_notes c where c.invoice_id = i.id), 0)
                 - (coalesce((select sum(p.amount_cents) from payments p where p.invoice_id = i.id and p.voided_at is null), 0)
                    - coalesce((select sum(r.amount_cents) from refunds r where r.invoice_id = i.id), 0)) as b
            from invoices i where i.status = 'issued'
        ), per as (
          select customer_id, sum(greatest(b, 0)) as owed, sum(greatest(-b, 0)) as overpaid,
                 min(issued_at) filter (where b > 0) as oldest_unpaid
            from bal group by customer_id
        ), credit as (
          select customer_id, sum(amount_cents) as credit from account_credits group by customer_id
        )
        select c.id as customer_id, c.last_name || ', ' || c.first_name as customer_name,
               coalesce(per.owed, 0)::bigint as owed_cents, coalesce(per.overpaid, 0)::bigint as overpaid_cents,
               coalesce(credit.credit, 0)::bigint as credit_cents, per.oldest_unpaid::text as oldest_unpaid
          from customers c left join per on per.customer_id = c.id left join credit on credit.customer_id = c.id
         where coalesce(per.owed, 0) <> 0 or coalesce(per.overpaid, 0) <> 0 or coalesce(credit.credit, 0) <> 0
         order by coalesce(per.owed, 0) desc, customer_name`.execute(trx);
      const items = rows.rows.map((r) => ({ ...r, owedCents: n(r.owedCents), overpaidCents: n(r.overpaidCents), creditCents: n(r.creditCents) }));
      return {
        asOf: new Date().toISOString(),
        items,
        totals: {
          owedCents: items.reduce((a, r) => a + r.owedCents, 0),
          overpaidCents: items.reduce((a, r) => a + r.overpaidCents, 0),
          creditCents: items.reduce((a, r) => a + r.creditCents, 0),
        },
      };
    }),
  );

  app.get("/occupancy", { preHandler: app.authorize("reports:read") }, async (req) => {
    const { from, to } = reportRangeQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      const orgTz = await orgTimezone(trx, req.auth.orgId);
      // Build the list of local dates in the range (noon UTC avoids any date shifting).
      const days = daysCovered(new Date(`${from}T12:00:00Z`), new Date(`${to}T12:00:00Z`), "UTC");
      const locations = await trx.selectFrom("locations").select(["id", "name", "timezone"]).where("isActive", "=", true).orderBy("name").execute();
      const statuses = ["pending", "confirmed", "checked_in", "completed"];
      return {
        from, to,
        locations: await Promise.all(locations.map(async (l) => {
          const tz = l.timezone ?? orgTz;
          const [daycare, boarding] = await Promise.all([
            occupancy(trx, { locationId: l.id, category: "daycare", periods: days, timeZone: tz, statuses }),
            occupancy(trx, { locationId: l.id, category: "boarding", periods: days, timeZone: tz, statuses }),
          ]);
          const summarize = (rows: typeof daycare) => {
            const total = rows.reduce((a, r) => a + r.booked, 0);
            const limit = rows[0]?.limit ?? null;
            return {
              petDays: total, averagePerDay: rows.length ? Math.round((total / rows.length) * 10) / 10 : 0,
              peak: rows.reduce((a, r) => Math.max(a, r.booked), 0),
              utilizationPercent: limit ? Math.round((total / (limit * rows.length)) * 1000) / 10 : null,
              limit,
            };
          };
          return {
            locationId: l.id, locationName: l.name,
            days: days.map((date, i) => ({ date, daycare: daycare[i]!.booked, boarding: boarding[i]!.booked, daycareLimit: daycare[i]!.limit, boardingLimit: boarding[i]!.limit })),
            daycare: summarize(daycare), boarding: summarize(boarding),
          };
        })),
      };
    });
  });
};
