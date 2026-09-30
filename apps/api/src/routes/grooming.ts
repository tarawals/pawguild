/**
 * Grooming schedule: a day's grooming appointments at a location, grouped by groomer, plus
 * assigning (or changing) the groomer on an appointment, including after the pet has arrived.
 */
import { groomingScheduleQuery } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant } from "../db";
import { recordAudit } from "../lib/audit";
import { AppError, forbidden, notFound } from "../lib/errors";
import { checkGroomer, groomingStaff } from "../lib/grooming";
import { locationTimezone } from "../lib/hours";
import { idParam } from "../lib/params";

const assignInput = z.object({ membershipId: z.uuid().nullable() });
const ASSIGNABLE_STATUSES: readonly string[] = ["pending", "confirmed", "checked_in"];

export const groomingRoutes: FastifyPluginAsync = async (app) => {
  app.get("/staff", { preHandler: app.authorize("reservations:read") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => ({ items: await groomingStaff(trx, req.auth.orgId) })));

  app.get("/schedule", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const { date, locationId } = groomingScheduleQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let lq = trx.selectFrom("locations").select(["id", "name"]).where("isActive", "=", true).orderBy("name");
      if (locationId) lq = lq.where("id", "=", locationId);
      const location = await lq.executeTakeFirst();
      if (!location) throw notFound("Location");
      const timeZone = await locationTimezone(trx, location.id, req.auth.orgId);
      const dayStart = sql<Date>`(${date}::date)::timestamp at time zone ${timeZone}`;
      const dayEnd = sql<Date>`(${date}::date + 1)::timestamp at time zone ${timeZone}`;
      const appointments = await trx.selectFrom("reservations as r")
        .innerJoin("services as s", "s.id", "r.serviceId")
        .innerJoin("customers as c", "c.id", "r.customerId")
        .select(["r.id", "r.status", "r.startsAt", "r.endsAt", "r.notes", "r.groomerMembershipId", "s.name as serviceName", "r.customerId"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .select(sql<{ id: string; name: string; breed: string | null; resourceName: string | null }[]>`(
            select coalesce(json_agg(json_build_object('id', p.id, 'name', p.name, 'breed', p.breed, 'resourceName', res.name) order by p.name), '[]')
              from reservation_pets rp join pets p on p.id = rp.pet_id left join resources res on res.id = rp.resource_id
             where rp.reservation_id = r.id)`.as("pets"))
        .where("r.locationId", "=", location.id)
        .where("s.category", "=", "grooming")
        .where("r.status", "<>", "cancelled")
        .where("r.startsAt", "<", dayEnd)
        .where("r.endsAt", ">", dayStart)
        .orderBy("r.startsAt").orderBy("r.id")
        .execute();
      const staff = await groomingStaff(trx, req.auth.orgId);
      // Columns: every active groomer, plus anyone else with an appointment that day.
      const assigned = new Set(appointments.map((a) => a.groomerMembershipId).filter(Boolean));
      const columns = staff.filter((s) => s.role === "groomer" || assigned.has(s.membershipId));
      // An appointment may be assigned to someone since deactivated; show them too.
      const missing = [...assigned].filter((id) => !columns.some((c) => c.membershipId === id)) as string[];
      if (missing.length) {
        const extra = await trx.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
          .select(["m.id as membershipId", "m.role", "m.jobTitle", "u.firstName", "u.lastName"])
          .where("m.id", "in", missing).execute();
        columns.push(...extra.map((e) => ({ membershipId: e.membershipId, role: e.role, jobTitle: e.jobTitle, name: `${e.firstName} ${e.lastName} (inactive)` })));
      }
      return { date, timeZone, location, groomers: columns, appointments };
    });
  });

  /** Assign, change or clear the groomer. Allowed until the appointment is completed. */
  app.put("/appointments/:id/groomer", { preHandler: app.authorize("reservations:read") }, async (req) => {
    if (!req.auth.permissions.has("reservations:write") && !req.auth.permissions.has("stays:check_in_out")) throw forbidden();
    const id = idParam(req.params, "Appointment");
    const { membershipId } = assignInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations as r").innerJoin("services as s", "s.id", "r.serviceId")
        .select(["r.id", "r.status", "r.startsAt", "r.endsAt", "r.locationId", "r.groomerMembershipId", "s.category"])
        .where("r.id", "=", id).forUpdate("r").executeTakeFirst();
      if (!r) throw notFound("Appointment");
      if (r.category !== "grooming") throw new AppError(422, "invalid_reservation", "A groomer can only be assigned to a grooming appointment.");
      if (!ASSIGNABLE_STATUSES.includes(r.status)) {
        throw new AppError(409, "not_editable", "The groomer can't be changed on a completed, cancelled or no-show appointment.");
      }
      if (membershipId === r.groomerMembershipId) return { groomerMembershipId: membershipId };
      if (membershipId) {
        await checkGroomer(trx, {
          orgId: req.auth.orgId, membershipId, startsAt: r.startsAt, endsAt: r.endsAt, excludeReservationId: id,
          timeZone: await locationTimezone(trx, r.locationId, req.auth.orgId),
        });
      }
      await trx.updateTable("reservations").set({ groomerMembershipId: membershipId }).where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: "reservation.groomer_assigned", entityType: "reservation", entityId: id,
        changes: { groomerMembershipId: { from: r.groomerMembershipId, to: membershipId } } });
      return { groomerMembershipId: membershipId };
    });
  });
};
