import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { calendarDate } from "@pawguild/shared";
import { withTenant } from "../db";
import { occupancy } from "../lib/capacity";
import { todaysDoses } from "../lib/care";
import { billingSummary } from "./billing";
import { reservationVaccinationChecks } from "../lib/vaccinations";

/**
 * Operational summary: what needs attention today. Everything is computed from live records,
 * never from stored counters. "Today" is the organization's local date.
 */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/summary", { preHandler: app.authorize() }, async (req) => {
    return withTenant(app.db, req.auth, async (trx) => {
      const { timezone } = await trx.selectFrom("organizations").select("timezone")
        .where("id", "=", req.auth.orgId).executeTakeFirstOrThrow();
      const localDate = (col: string) => sql`(${sql.ref(col)} at time zone ${timezone})::date`;
      const today = sql`(now() at time zone ${timezone})::date`;

      const counts = await trx.selectNoFrom([
        sql<number>`(select count(*) from customers where archived_at is null)::int`.as("activeCustomers"),
        sql<number>`(select count(*) from pets where archived_at is null and status = 'active')::int`.as("activePets"),
        sql<number>`(select count(*) from reservation_pets rp join reservations r on r.id = rp.reservation_id
                     where r.status = 'checked_in')::int`.as("petsCheckedIn"),
      ]).executeTakeFirstOrThrow();

      const reservationRow = (q: ReturnType<typeof base>) => q.orderBy("r.startsAt").limit(50).execute();
      const base = () => trx.selectFrom("reservations as r")
        .innerJoin("customers as c", "c.id", "r.customerId")
        .innerJoin("services as s", "s.id", "r.serviceId")
        .select(["r.id", "r.status", "r.startsAt", "r.endsAt", "s.name as serviceName"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .select(sql<string[]>`(select coalesce(array_agg(p.name order by p.name), '{}') from reservation_pets rp
                 join pets p on p.id = rp.pet_id where rp.reservation_id = r.id)`.as("petNames"));

      const [arrivals, departures] = await Promise.all([
        reservationRow(base().where("r.status", "in", ["pending", "confirmed"]).where(localDate("r.starts_at"), "=", today)),
        reservationRow(base().where("r.status", "=", "checked_in").where(localDate("r.ends_at"), "<=", today)),
      ]);

      // Active pets whose latest (non-voided) record for any vaccine expires within 30 days or has expired.
      const vaccinationAlerts = await trx
        .selectFrom("petVaccinations as v")
        .innerJoin("pets as p", "p.id", "v.petId")
        .innerJoin("customers as c", "c.id", "p.customerId")
        .select(["p.id as petId", "p.name as petName", "v.vaccine", "c.firstName", "c.lastName"])
        .select(sql<string>`max(v.expires_on)::text`.as("expiresOn"))
        .where("v.voidedAt", "is", null)
        .where("p.archivedAt", "is", null)
        .where("p.status", "=", "active")
        .groupBy(["p.id", "p.name", "v.vaccine", "c.firstName", "c.lastName"])
        .having(sql`max(v.expires_on)`, "<=", sql`${today} + 30`)
        .orderBy(sql`max(v.expires_on)`)
        .limit(25)
        .execute();

      // Daycare pets today and boarding pets tonight, per active location, against configured limits.
      const locations = await trx.selectFrom("locations").select(["id", "name", "timezone"])
        .where("isActive", "=", true).orderBy("name").execute();
      const occupancyByLocation = await Promise.all(locations.map(async (l) => {
        const tz = l.timezone ?? timezone;
        const day = calendarDate(new Date(), tz);
        const [daycare] = await occupancy(trx, { locationId: l.id, category: "daycare", periods: [day], timeZone: tz });
        const [boarding] = await occupancy(trx, { locationId: l.id, category: "boarding", periods: [day], timeZone: tz });
        return { locationId: l.id, locationName: l.name, daycare: daycare!, boarding: boarding! };
      }));

      // Flag arrivals that will fail check-in verification so staff can sort it out beforehand.
      const checks = await reservationVaccinationChecks(trx, arrivals.map((a) => a.id));
      const arrivalsWithChecks = arrivals.map((a) => ({
        ...a,
        petsNeedingVaccinations: (checks.get(a.id) ?? []).filter((p) => !p.ok).map((p) => p.petName),
      }));

      // Medication due now or overdue (and the next two hours), and incidents awaiting resolution.
      const soon = Date.now() + 2 * 3600_000;
      const medicationDue = (await todaysDoses(trx))
        .filter((d) => d.status === "overdue" || (d.status === "due" && d.scheduledFor.getTime() <= soon));
      const openIncidents = await trx.selectFrom("incidents as i").innerJoin("pets as p", "p.id", "i.petId")
        .select(["i.id", "i.petId", "p.name as petName", "i.category", "i.severity", "i.occurredAt", "i.reservationId", "i.followUpRequired"])
        .where("i.resolvedAt", "is", null).orderBy("i.occurredAt", "desc").limit(20).execute();

      const outstanding = req.auth.permissions.has("billing:read") ? await billingSummary(trx) : null;

      // Staff on shift today (any shift overlapping the organization's local day).
      const workingToday = await trx.selectFrom("shifts as s")
        .innerJoin("memberships as m", "m.id", "s.membershipId").innerJoin("users as u", "u.id", "m.userId")
        .innerJoin("locations as l", "l.id", "s.locationId")
        .select(["s.id", "s.startsAt", "s.endsAt", "s.note", "s.membershipId", "m.role", "l.name as locationName"])
        .select(sql<string>`u.first_name || ' ' || u.last_name`.as("staffName"))
        .where("s.startsAt", "<", sql<Date>`((${today}) + 1)::timestamp at time zone ${timezone}`)
        .where("s.endsAt", ">", sql<Date>`(${today})::timestamp at time zone ${timezone}`)
        .orderBy("s.startsAt").orderBy("staffName").limit(100).execute();

      return {
        ...counts,
        outstanding,
        medicationDue,
        openIncidents,
        occupancy: occupancyByLocation,
        workingToday,
        arrivals: arrivalsWithChecks,
        departures,
        vaccinationAlerts: vaccinationAlerts.map(({ firstName, lastName, ...v }) => ({
          ...v,
          customerName: `${firstName} ${lastName}`,
        })),
      };
    });
  });
};
