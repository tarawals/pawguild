import { incidentInput, incidentUpdateInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { AppError, fieldError, forbidden, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const listQuery = z.object({
  open: z.coerce.boolean().optional(),
  petId: z.uuid().optional(),
  reservationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function baseQuery(trx: Tx) {
  return trx.selectFrom("incidents as i")
    .innerJoin("pets as p", "p.id", "i.petId")
    .innerJoin("users as u", "u.id", "i.reportedByUserId")
    .leftJoin("users as rv", "rv.id", "i.resolvedByUserId")
    .select(["i.id", "i.petId", "p.name as petName", "i.reservationId", "i.occurredAt", "i.category", "i.severity",
      "i.description", "i.actionsTaken", "i.ownerNotified", "i.followUpRequired", "i.followUpNotes", "i.createdAt",
      "i.updatedAt", "i.resolvedAt", "i.resolution"])
    .select(sql<string>`u.first_name || ' ' || u.last_name`.as("reportedBy"))
    .select(sql<string | null>`rv.first_name || ' ' || rv.last_name`.as("resolvedBy"));
}

async function getIncident(trx: Tx, id: string) {
  const row = await baseQuery(trx).where("i.id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Incident");
  return row;
}

export const incidentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const q = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let query = baseQuery(trx);
      if (q.open) query = query.where("i.resolvedAt", "is", null);
      if (q.petId) query = query.where("i.petId", "=", q.petId);
      if (q.reservationId) query = query.where("i.reservationId", "=", q.reservationId);
      return { items: await query.orderBy("i.occurredAt", "desc").limit(q.limit).execute() };
    });
  });

  app.get("/:id", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Incident");
    return withTenant(app.db, req.auth, (trx) => getIncident(trx, id));
  });

  app.post("/", { preHandler: app.authorize("incidents:record") }, async (req, reply) => {
    const input = incidentInput.parse(req.body);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + 5 * 60_000) throw fieldError("occurredAt", "That time is in the future");
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const pet = await trx.selectFrom("pets").select("id").where("id", "=", input.petId).executeTakeFirst();
      if (!pet) throw new AppError(422, "invalid_reference", "That pet was not found.");
      if (input.reservationId) {
        const onStay = await trx.selectFrom("reservationPets").select("petId")
          .where("reservationId", "=", input.reservationId).where("petId", "=", input.petId).executeTakeFirst();
        if (!onStay) throw new AppError(422, "invalid_reference", "That pet isn't on that reservation.");
      }
      const row = await trx.insertInto("incidents").values({
        organizationId: req.auth.orgId, petId: input.petId, reservationId: input.reservationId ?? null, occurredAt,
        category: input.category, severity: input.severity, description: input.description,
        actionsTaken: input.actionsTaken, ownerNotified: input.ownerNotified, followUpRequired: input.followUpRequired,
        reportedByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "incident.reported", entityType: "incident", entityId: row.id,
        changes: { petId: input.petId, category: input.category, severity: input.severity } });
      return getIncident(trx, row.id);
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { preHandler: app.authorize("incidents:record") }, async (req) => {
    const id = idParam(req.params, "Incident");
    const { resolution, ...input } = incidentUpdateInput.parse(req.body);
    if (resolution && !req.auth.permissions.has("incidents:resolve")) throw forbidden();
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getIncident(trx, id);
      if (before.resolvedAt) throw new AppError(409, "incident_resolved", "This incident is resolved and can no longer be changed.");
      await trx.updateTable("incidents").set({
        ...input,
        ...(resolution && { resolution, resolvedAt: new Date(), resolvedByUserId: req.auth.userId }),
      }).where("id", "=", id).execute();
      const after = await getIncident(trx, id);
      const changes = diff(before, after);
      delete changes.updatedAt; delete changes.resolvedBy;
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: resolution ? "incident.resolved" : "incident.updated", entityType: "incident", entityId: id, changes });
      }
      return after;
    });
  });
};
