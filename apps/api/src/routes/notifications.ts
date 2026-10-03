/**
 * Internal notifications: things that need someone's attention, computed from live records on
 * each request. Nothing is stored, so an item disappears as soon as the underlying problem is
 * dealt with (the dose is recorded, the stay is checked out, a groomer is assigned...).
 * Each item is shown only to people whose role can act on it.
 */
import { addDays, calendarDate, formatTimeOfDay, localParts } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { occupancy } from "../lib/capacity";
import { todaysDoses } from "../lib/care";
import { reservationVaccinationChecks } from "../lib/vaccinations";
import { billingSummary } from "./billing";
import { countDueMemberships } from "./memberships";

export type Severity = "high" | "medium" | "low";
export interface Notification {
  /** Stable key for the underlying problem. */
  id: string;
  kind: string;
  severity: Severity;
  title: string;
  detail?: string;
  link: string;
  /** When the problem is about (a dose time, a pick-up time), for ordering. */
  at: string | null;
}

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const petList = (names: string[]) => names.join(", ");
const dayName = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export async function buildNotifications(trx: Tx, auth: AuthContext, now = new Date()): Promise<Notification[]> {
  const can = (p: string) => auth.permissions.has(p as never);
  const org = await trx.selectFrom("organizations").select("timezone").where("id", "=", auth.orgId).executeTakeFirstOrThrow();
  const time = (d: Date, tz = org.timezone) => formatTimeOfDay(localParts(d, tz).time);
  const items: Notification[] = [];
  if (!can("reservations:read")) return items;

  const stays = (q: ReturnType<typeof staysBase>) => q.execute();
  const staysBase = () => trx.selectFrom("reservations as r")
    .innerJoin("services as s", "s.id", "r.serviceId")
    .innerJoin("locations as l", "l.id", "r.locationId")
    .select(["r.id", "r.status", "r.startsAt", "r.endsAt", "r.groomerMembershipId", "s.name as serviceName", "s.category", "l.timezone as locationTimezone"])
    .select(sql<string[]>`(select coalesce(array_agg(p.name order by p.name), '{}') from reservation_pets rp
             join pets p on p.id = rp.pet_id where rp.reservation_id = r.id)`.as("petNames"));

  // Medication doses overdue today.
  if (can("care:record") || can("stays:check_in_out")) {
    for (const d of (await todaysDoses(trx)).filter((x) => x.status === "overdue")) {
      items.push({
        id: `dose:${d.reservationId}:${d.medicationId}:${d.scheduledFor.toISOString()}`, kind: "medication_overdue", severity: "high",
        title: `Medication overdue: ${d.petName} — ${d.medicationName}`, detail: `${d.dosage}, due ${time(d.scheduledFor)}. Record it on Today's care.`,
        link: "/care", at: d.scheduledFor.toISOString(),
      });
    }
  }

  const [pastPickup, soon, grooming] = await Promise.all([
    // Pets still checked in more than 30 minutes after pick-up time.
    stays(staysBase().where("r.status", "=", "checked_in").where("r.endsAt", "<", new Date(now.getTime() - 30 * 60_000)).orderBy("r.endsAt").limit(50)),
    // Arrivals in the next 24 hours (and today's late ones) that aren't settled yet.
    stays(staysBase().where("r.status", "in", ["pending", "confirmed"])
      .where("r.startsAt", ">", new Date(now.getTime() - 12 * 3600_000)).where("r.startsAt", "<", new Date(now.getTime() + 48 * 3600_000))
      .orderBy("r.startsAt").limit(200)),
    // Grooming in the next 48 hours with nobody assigned.
    stays(staysBase().where("s.category", "=", "grooming").where("r.status", "in", ["pending", "confirmed", "checked_in"])
      .where("r.groomerMembershipId", "is", null)
      .where("r.endsAt", ">", now).where("r.startsAt", "<", new Date(now.getTime() + 48 * 3600_000)).orderBy("r.startsAt").limit(50)),
  ]);
  for (const r of pastPickup) {
    items.push({
      id: `pickup:${r.id}`, kind: "past_pickup", severity: "medium",
      title: `Past pick-up time: ${petList(r.petNames)}`, detail: `${r.serviceName}, due ${dayName(localParts(r.endsAt, r.locationTimezone ?? org.timezone).date)} at ${time(r.endsAt, r.locationTimezone ?? org.timezone)}. Check out, or extend the stay.`,
      link: `/reservations/${r.id}`, at: r.endsAt.toISOString(),
    });
  }
  const within24h = soon.filter((r) => r.startsAt.getTime() < now.getTime() + 24 * 3600_000);
  const vaccines = await reservationVaccinationChecks(trx, within24h.map((r) => r.id));
  for (const r of within24h) {
    const missing = (vaccines.get(r.id) ?? []).filter((p) => !p.ok).map((p) => p.petName);
    if (missing.length) {
      items.push({
        id: `vaccines:${r.id}`, kind: "vaccinations_needed", severity: "medium",
        title: `Vaccinations needed before check-in: ${petList(missing)}`, detail: `${r.serviceName} arriving ${time(r.startsAt, r.locationTimezone ?? org.timezone)}. Record current vaccinations first.`,
        link: `/reservations/${r.id}`, at: r.startsAt.toISOString(),
      });
    }
  }
  for (const r of soon.filter((x) => x.status === "pending")) {
    const tz = r.locationTimezone ?? org.timezone;
    items.push({
      id: `pending:${r.id}`, kind: "unconfirmed", severity: "low",
      title: `Not confirmed yet: ${petList(r.petNames)}`, detail: `${r.serviceName} on ${dayName(localParts(r.startsAt, tz).date)} at ${time(r.startsAt, tz)}. Confirm with the customer.`,
      link: `/reservations/${r.id}`, at: r.startsAt.toISOString(),
    });
  }
  for (const r of grooming) {
    const tz = r.locationTimezone ?? org.timezone;
    const date = localParts(r.startsAt, tz).date;
    items.push({
      id: `groomer:${r.id}`, kind: "no_groomer", severity: date === calendarDate(now, tz) ? "medium" : "low",
      title: `No groomer assigned: ${petList(r.petNames)}`, detail: `${r.serviceName} on ${dayName(date)} at ${time(r.startsAt, tz)}.`,
      link: `/grooming?date=${date}`, at: r.startsAt.toISOString(),
    });
  }

  // Open incidents: high severity, or waiting on a follow-up.
  const incidents = await trx.selectFrom("incidents as i").innerJoin("pets as p", "p.id", "i.petId")
    .select(["i.id", "i.category", "i.severity", "i.occurredAt", "i.followUpRequired", "i.ownerNotified", "p.name as petName"])
    .where("i.resolvedAt", "is", null)
    .where((eb) => eb.or([eb("i.severity", "=", "high"), eb("i.followUpRequired", "=", true)]))
    .orderBy("i.occurredAt", "desc").limit(50).execute();
  for (const i of incidents) {
    items.push({
      id: `incident:${i.id}`, kind: "open_incident", severity: i.severity === "high" ? "high" : "medium",
      title: `${i.severity === "high" ? "Serious incident" : "Incident needs follow-up"}: ${i.petName} (${i.category.replace(/_/g, " ")})`,
      detail: `${i.ownerNotified ? "" : "Owner not told yet. "}${can("incidents:resolve") ? "Review and resolve it." : "A manager needs to resolve it."}`,
      link: "/incidents", at: i.occurredAt.toISOString(),
    });
  }

  // Over capacity today (daycare) or tonight (boarding), e.g. after a manager override.
  const locations = await trx.selectFrom("locations").select(["id", "name", "timezone"]).where("isActive", "=", true).orderBy("name").execute();
  for (const l of locations) {
    const tz = l.timezone ?? org.timezone;
    const day = calendarDate(now, tz);
    for (const category of ["daycare", "boarding"] as const) {
      const [o] = await occupancy(trx, { locationId: l.id, category, periods: [day], timeZone: tz });
      if (o && o.limit !== null && o.booked > o.limit) {
        items.push({
          id: `capacity:${l.id}:${category}:${day}`, kind: "over_capacity", severity: "high",
          title: `${category === "daycare" ? "Daycare" : "Boarding"} over capacity ${category === "daycare" ? "today" : "tonight"} at ${l.name}`,
          detail: `${o.booked} pets booked for ${o.limit} spaces.`, link: `/reservations`, at: null,
        });
      }
    }
  }

  // Overpaid invoices waiting for a refund or a move to account credit.
  if (can("billing:read")) {
    const { overpaidInvoices } = await billingSummary(trx);
    if (overpaidInvoices > 0) {
      items.push({
        id: "billing:overpaid", kind: "overpaid_invoices", severity: "low",
        title: `${overpaidInvoices} overpaid invoice${overpaidInvoices === 1 ? "" : "s"}`,
        detail: can("billing:refund") ? "Refund the difference or move it to account credit." : "A manager needs to refund or move it to account credit.",
        link: "/invoices?status=overpaid", at: null,
      });
    }
  }

  // Membership months due to be billed (staff issue the invoices with "Bill due memberships").
  if (can("billing:write")) {
    const due = await countDueMemberships(trx, auth.orgId);
    if (due > 0) {
      items.push({
        id: "memberships:due", kind: "memberships_due", severity: "medium",
        title: `${due} membership${due === 1 ? "" : "s"} due to be billed`, detail: "Bill them on the Memberships page; each month gets its own invoice.",
        link: "/memberships", at: null,
      });
    }
  }

  // Packages about to expire with days left, or down to their last day (a chance to renew).
  if (can("billing:read")) {
    const today = calendarDate(now, org.timezone);
    const soon = await sql<{ id: string; customerId: string; customerName: string; name: string; covers: string; days: number; expiresOn: string | null; used: number }>`
      select cp.id, cp.customer_id, c.first_name || ' ' || c.last_name as customer_name, cp.name, cp.covers, cp.days, cp.expires_on::text as expires_on,
             (select count(*) from package_redemptions r join invoices ri on ri.id = r.invoice_id
               where r.customer_package_id = cp.id and ri.status <> 'void')::int as used
        from customer_packages cp join invoices i on i.id = cp.invoice_id join customers c on c.id = cp.customer_id
       where i.status <> 'void' and (cp.expires_on is null or cp.expires_on >= ${today}::date)
       order by cp.expires_on nulls last limit 500`.execute(trx);
    for (const p of soon.rows) {
      const left = p.days - p.used;
      const kind = (n: number) => `${p.covers === "full_day" ? "full" : "half"} day${n === 1 ? "" : "s"}`;
      if (left <= 0) continue;
      if (p.expiresOn && p.expiresOn <= addDays(today, 7)) {
        items.push({
          id: `package-expiring:${p.id}`, kind: "package_expiring", severity: "low",
          title: `Package expiring: ${p.customerName} — ${p.name}`, detail: `${left} ${kind(left)} left, use by ${dayName(p.expiresOn)}.`,
          link: `/customers/${p.customerId}`, at: `${p.expiresOn}T00:00:00.000Z`,
        });
      } else if (left === 1) {
        items.push({
          id: `package-last-day:${p.id}`, kind: "package_last_day", severity: "low",
          title: `Last day on package: ${p.customerName} — ${p.name}`, detail: "Offer a new package next visit.",
          link: `/customers/${p.customerId}`, at: null,
        });
      }
    }
  }

  // Open days in the coming week with nobody scheduled (only once the business uses the schedule).
  if (can("schedules:manage")) {
    const usesSchedule = await trx.selectFrom("shifts").select("id")
      .where("startsAt", ">", new Date(now.getTime() - 30 * 86_400_000)).limit(1).executeTakeFirst();
    if (usesSchedule) {
      for (const l of locations) {
        const tz = l.timezone ?? org.timezone;
        const today = calendarDate(now, tz);
        const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
        const [hours, closures, shifts] = await Promise.all([
          trx.selectFrom("locationHours").select("weekday").where("locationId", "=", l.id).execute(),
          trx.selectFrom("locationClosures").select("closedOn").where("locationId", "=", l.id).where("closedOn", "in", days).execute(),
          sql<{ day: string }>`select distinct (starts_at at time zone ${tz})::date::text as day from shifts
             where location_id = ${l.id} and (starts_at at time zone ${tz})::date between ${today}::date and ${days[6]}::date`.execute(trx),
        ]);
        const staffed = new Set(shifts.rows.map((s) => s.day));
        for (const day of days) {
          const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
          const open = (hours.length === 0 || hours.some((h) => h.weekday === weekday)) && !closures.some((c) => c.closedOn === day);
          if (open && !staffed.has(day)) {
            items.push({
              id: `unstaffed:${l.id}:${day}`, kind: "unstaffed_day", severity: day === today ? "high" : "medium",
              title: `Nobody scheduled at ${l.name} on ${dayName(day)}`, detail: "Add shifts on the staff schedule.",
              link: `/schedule?week=${day}${locations.length > 1 ? `&location=${l.id}` : ""}`, at: `${day}T00:00:00.000Z`,
            });
          }
        }
      }
    }
  }

  return items.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (a.at ?? "").localeCompare(b.at ?? "") || a.title.localeCompare(b.title));
}

export const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize() }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const items = await buildNotifications(trx, req.auth);
      const counts = { high: 0, medium: 0, low: 0 };
      for (const i of items) counts[i.severity]++;
      return { items, counts, total: items.length };
    }));
};
