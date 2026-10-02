import {
  capacityLimitsInput, hhmm, localParts, locationClosureInput, locationHoursInput, locationInput, locationUpdateInput, taxRateInput,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { AppError, fieldError, notFound } from "../lib/errors";
import { locationTimezone } from "../lib/hours";
import { idParam } from "../lib/params";

const listQuery = z.object({ includeInactive: z.enum(["true", "false"]).optional() });
const DETAIL_COLUMNS = ["id", "name", "addressLine1", "addressLine2", "city", "region", "postalCode", "country", "phone", "email",
  "timezone", "isActive", "taxRateBps"] as const;

async function assertTimezoneKnownToDb(trx: Tx, tz: string | null | undefined) {
  if (!tz) return;
  const row = await sql<{ ok: boolean }>`select exists (select 1 from pg_timezone_names where name = ${tz}) as ok`.execute(trx);
  if (!row.rows[0]?.ok) throw fieldError("timezone", "Choose a time zone from the list");
}

async function assertNameFree(trx: Tx, name: string, exceptId?: string) {
  let q = trx.selectFrom("locations").select("id").where(sql`lower(name)`, "=", name.toLowerCase());
  if (exceptId) q = q.where("id", "<>", exceptId);
  if (await q.executeTakeFirst()) throw fieldError("name", "Another location already has this name");
}

async function listLocations(trx: Tx, orgTimezone: string, includeInactive: boolean, onlyId?: string) {
  let q = trx.selectFrom("locations").select([...DETAIL_COLUMNS]).orderBy("isActive", "desc").orderBy("name");
  if (!includeInactive) q = q.where("isActive", "=", true);
  if (onlyId) q = q.where("id", "=", onlyId);
  const locations = await q.execute();
  const ids = locations.map((l) => l.id);
  if (ids.length === 0) return [];
  const [limits, hours, closures] = await Promise.all([
    trx.selectFrom("locationCapacities").select(["locationId", "category", "maxPets"]).where("locationId", "in", ids).execute(),
    trx.selectFrom("locationHours").select(["locationId", "weekday", "opensAt", "closesAt"]).where("locationId", "in", ids).orderBy("weekday").execute(),
    // Closures from a week ago onward (older ones are history, kept in the table and audit log).
    trx.selectFrom("locationClosures").select(["id", "locationId", "closedOn", "reason"]).where("locationId", "in", ids)
      .where("closedOn", ">=", sql<string>`current_date - 7`).orderBy("closedOn").execute(),
  ]);
  return locations.map((l) => {
    const of = (c: string) => limits.find((x) => x.locationId === l.id && x.category === c)?.maxPets ?? null;
    const effectiveTimezone = l.timezone ?? orgTimezone;
    const today = localParts(new Date(), effectiveTimezone).date;
    return {
      ...l,
      effectiveTimezone,
      capacity: { daycare: of("daycare"), boarding: of("boarding") },
      hours: hours.filter((h) => h.locationId === l.id).map((h) => ({ weekday: h.weekday, opensAt: hhmm(h.opensAt), closesAt: hhmm(h.closesAt) })),
      closures: closures.filter((c) => c.locationId === l.id && c.closedOn >= today).map(({ locationId: _, ...c }) => c),
    };
  });
}

async function orgTimezone(trx: Tx, orgId: string) {
  return (await trx.selectFrom("organizations").select("timezone").where("id", "=", orgId).executeTakeFirstOrThrow()).timezone;
}

export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize() }, async (req) => {
    const { includeInactive } = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) =>
      ({ items: await listLocations(trx, await orgTimezone(trx, req.auth.orgId), includeInactive === "true") }));
  });

  app.post("/", { preHandler: app.authorize("locations:manage") }, async (req, reply) => {
    const input = locationInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      await assertTimezoneKnownToDb(trx, input.timezone);
      await assertNameFree(trx, input.name);
      const row = await trx.insertInto("locations").values({ organizationId: req.auth.orgId, ...input }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "location.created", entityType: "location", entityId: row.id, changes: input });
      return (await listLocations(trx, await orgTimezone(trx, req.auth.orgId), true, row.id))[0];
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { preHandler: app.authorize("locations:manage") }, async (req) => {
    const id = idParam(req.params, "Location");
    const input = locationUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("locations").select([...DETAIL_COLUMNS]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!before) throw notFound("Location");
      await assertTimezoneKnownToDb(trx, input.timezone);
      if (input.name !== undefined) await assertNameFree(trx, input.name, id);
      if (input.isActive === false && before.isActive) {
        const others = await trx.selectFrom("locations").select("id").where("isActive", "=", true).where("id", "<>", id).executeTakeFirst();
        if (!others) throw new AppError(409, "last_location", "This is the only active location. Add or reactivate another location first.");
        const upcoming = await trx.selectFrom("reservations").select((eb) => eb.fn.countAll<number>().as("n"))
          .where("locationId", "=", id).where("status", "in", ["pending", "confirmed", "checked_in"]).where("endsAt", ">", new Date())
          .executeTakeFirstOrThrow();
        if (Number(upcoming.n) > 0) {
          throw new AppError(409, "location_in_use",
            `This location has ${upcoming.n} upcoming or current reservation${Number(upcoming.n) === 1 ? "" : "s"}. Complete, cancel or move them before deactivating it.`);
        }
      }
      if (Object.keys(input).length > 0) {
        const after = await trx.updateTable("locations").set(input).where("id", "=", id).returning([...DETAIL_COLUMNS]).executeTakeFirstOrThrow();
        const changes = diff(before, after);
        if (Object.keys(changes).length > 0) {
          const action = input.isActive === false && before.isActive ? "location.deactivated"
            : input.isActive === true && !before.isActive ? "location.reactivated" : "location.updated";
          await recordAudit(trx, req.auth, { action, entityType: "location", entityId: id, changes });
        }
      }
      return (await listLocations(trx, await orgTimezone(trx, req.auth.orgId), true, id))[0];
    });
  });

  /** Replace the weekly hours. Days left out are closed; an empty list removes the hours restriction. */
  app.put("/:id/hours", { preHandler: app.authorize("locations:manage") }, async (req) => {
    const id = idParam(req.params, "Location");
    const { days } = locationHoursInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const location = await trx.selectFrom("locations").select("id").where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!location) throw notFound("Location");
      const before = (await trx.selectFrom("locationHours").select(["weekday", "opensAt", "closesAt"]).where("locationId", "=", id).orderBy("weekday").execute())
        .map((h) => ({ weekday: h.weekday, opensAt: hhmm(h.opensAt), closesAt: hhmm(h.closesAt) }));
      const after = [...days].sort((a, b) => a.weekday - b.weekday);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await trx.deleteFrom("locationHours").where("locationId", "=", id).execute();
        if (after.length > 0) {
          await trx.insertInto("locationHours").values(after.map((d) => ({ organizationId: req.auth.orgId, locationId: id, ...d }))).execute();
        }
        await recordAudit(trx, req.auth, { action: "location.hours_updated", entityType: "location", entityId: id, changes: { hours: { from: before, to: after } } });
      }
      return { hours: after };
    });
  });

  app.post("/:id/closures", { preHandler: app.authorize("locations:manage") }, async (req, reply) => {
    const id = idParam(req.params, "Location");
    const input = locationClosureInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const location = await trx.selectFrom("locations").select("id").where("id", "=", id).executeTakeFirst();
      if (!location) throw notFound("Location");
      const existing = await trx.selectFrom("locationClosures").select("id").where("locationId", "=", id).where("closedOn", "=", input.closedOn).executeTakeFirst();
      if (existing) throw fieldError("closedOn", "That day is already marked as closed");
      const row = await trx.insertInto("locationClosures").values({ organizationId: req.auth.orgId, locationId: id, ...input })
        .returning(["id", "closedOn", "reason"]).executeTakeFirstOrThrow();
      const tz = await locationTimezone(trx, id, req.auth.orgId);
      const onDay = (col: "starts_at" | "ends_at") => sql<boolean>`(${sql.ref(col)} at time zone ${tz})::date = ${input.closedOn}::date`;
      const booked = await trx.selectFrom("reservations").select((eb) => eb.fn.countAll<number>().as("n"))
        .where("locationId", "=", id).where("status", "in", ["pending", "confirmed", "checked_in"])
        .where((eb) => eb.or([onDay("starts_at"), onDay("ends_at")]))
        .executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "location.closure_added", entityType: "location", entityId: id, changes: input });
      // Existing bookings are left alone; staff are told how many drop off or pick up that day.
      return { ...row, affectedReservations: Number(booked.n) };
    });
    return reply.status(201).send(created);
  });

  app.delete("/:id/closures/:closureId", { preHandler: app.authorize("locations:manage") }, async (req) => {
    const id = idParam(req.params, "Location");
    const closureId = idParam({ id: (req.params as { closureId?: string }).closureId }, "Closure");
    return withTenant(app.db, req.auth, async (trx) => {
      const removed = await trx.deleteFrom("locationClosures").where("id", "=", closureId).where("locationId", "=", id)
        .returning(["closedOn", "reason"]).executeTakeFirst();
      if (!removed) throw notFound("Closure");
      await recordAudit(trx, req.auth, { action: "location.closure_removed", entityType: "location", entityId: id, changes: removed });
      return { ok: true };
    });
  });

  app.put("/:id/tax-rate", { preHandler: app.authorize("locations:manage") }, async (req) => {
    const id = idParam(req.params, "Location");
    const { taxRateBps } = taxRateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("locations").select("taxRateBps").where("id", "=", id).executeTakeFirst();
      if (!before) throw notFound("Location");
      if (before.taxRateBps !== taxRateBps) {
        await trx.updateTable("locations").set({ taxRateBps }).where("id", "=", id).execute();
        await recordAudit(trx, req.auth, { action: "location.tax_rate_updated", entityType: "location", entityId: id,
          changes: { taxRateBps: { from: before.taxRateBps, to: taxRateBps } } });
      }
      return { taxRateBps };
    });
  });

  app.put("/:id/capacity", { preHandler: app.authorize("locations:manage") }, async (req) => {
    const id = idParam(req.params, "Location");
    const input = capacityLimitsInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const location = await trx.selectFrom("locations").select("id").where("id", "=", id).executeTakeFirst();
      if (!location) throw notFound("Location");
      const before = await trx.selectFrom("locationCapacities").select(["category", "maxPets"]).where("locationId", "=", id).execute();
      const changes: Record<string, { from: number | null; to: number | null }> = {};
      for (const category of ["daycare", "boarding"] as const) {
        const from = before.find((b) => b.category === category)?.maxPets ?? null;
        const to = input[category];
        if (from === to) continue;
        changes[category] = { from, to };
        if (to === null) {
          await trx.deleteFrom("locationCapacities").where("locationId", "=", id).where("category", "=", category).execute();
        } else {
          await trx.insertInto("locationCapacities")
            .values({ organizationId: req.auth.orgId, locationId: id, category, maxPets: to })
            .onConflict((oc) => oc.columns(["locationId", "category"]).doUpdateSet({ maxPets: to }))
            .execute();
        }
      }
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "location.capacity_updated", entityType: "location", entityId: id, changes });
      }
      return { capacity: input };
    });
  });
};
