import { resourceInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { AppError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const COLUMNS = ["id", "locationId", "name", "kind", "capacity", "notes", "isActive", "createdAt", "updatedAt"] as const;
const ACTIVE = ["pending", "confirmed", "checked_in"] as const;

/** Natural order so "Kennel 2" sorts before "Kennel 10". */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byKindThenName = <T extends { kind: string; name: string }>(a: T, b: T) =>
  a.kind.localeCompare(b.kind) || collator.compare(a.name, b.name);

async function getResource(trx: Tx, id: string) {
  const row = await trx.selectFrom("resources").select(COLUMNS).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Kennel or room");
  return row;
}

const availabilityQuery = z.object({
  locationId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  excludeReservationId: z.uuid().optional(),
});

export const resourceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const q = z.object({ locationId: z.uuid().optional(), includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let query = trx.selectFrom("resources").select(COLUMNS);
      if (q.locationId) query = query.where("locationId", "=", q.locationId);
      if (!q.includeInactive) query = query.where("isActive", "=", true);
      return { items: (await query.execute()).sort(byKindThenName) };
    });
  });

  /** How many pets each active resource already holds during a time window. */
  app.get("/availability", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const q = availabilityQuery.parse(req.query);
    const startsAt = new Date(q.startsAt);
    const endsAt = new Date(q.endsAt);
    if (endsAt <= startsAt) throw new AppError(400, "validation_failed", "Some fields need attention.", [{ path: "endsAt", message: "End must be after the start" }]);
    return withTenant(app.db, req.auth, async (trx) => {
      const rows = await trx.selectFrom("resources as res")
        .select(["res.id", "res.name", "res.kind", "res.capacity"])
        .select((eb) => eb.selectFrom("reservationPets as rp").innerJoin("reservations as r", "r.id", "rp.reservationId")
          .select((e) => e.fn.countAll<number>().as("n"))
          .whereRef("rp.resourceId", "=", "res.id")
          .where("r.status", "in", ACTIVE).where("r.startsAt", "<", endsAt).where("r.endsAt", ">", startsAt)
          .$if(Boolean(q.excludeReservationId), (qb) => qb.where("r.id", "<>", q.excludeReservationId!))
          .as("occupied"))
        .where("res.locationId", "=", q.locationId).where("res.isActive", "=", true)
        .execute();
      rows.sort(byKindThenName);
      return { items: rows.map((r) => ({ ...r, occupied: Number(r.occupied ?? 0), available: r.capacity - Number(r.occupied ?? 0) })) };
    });
  });

  app.post("/", { preHandler: app.authorize("resources:manage") }, async (req, reply) => {
    const input = resourceInput.parse(req.body);
    const row = await withTenant(app.db, req.auth, async (trx) => {
      const location = await trx.selectFrom("locations").select("id").where("id", "=", input.locationId).executeTakeFirst();
      if (!location) throw new AppError(422, "invalid_reference", "That location was not found.");
      const created = await trx.insertInto("resources").values({ ...input, organizationId: req.auth.orgId })
        .returning(COLUMNS).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "resource.created", entityType: "resource", entityId: created.id,
        changes: { name: created.name, kind: created.kind, capacity: created.capacity } });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/:id", { preHandler: app.authorize("resources:manage") }, async (req) => {
    const id = idParam(req.params, "Kennel or room");
    const input = resourceInput.omit({ locationId: true }).partial().parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getResource(trx, id);
      // An empty update (nothing changed) is a no-op rather than an SQL error.
      if (Object.keys(input).length === 0) return before;
      const after = await trx.updateTable("resources").set(input).where("id", "=", id).returning(COLUMNS).executeTakeFirstOrThrow();
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "resource.updated", entityType: "resource", entityId: id, changes });
      }
      return after;
    });
  });
};
