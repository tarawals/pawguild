import { medicationInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { recordAudit } from "../lib/audit";
import { AppError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

/** Standing medication orders, mounted under /api/pets/:id/medications. */
export async function listMedications(trx: Tx, petId: string, includeDiscontinued = false) {
  let q = trx.selectFrom("petMedications")
    .select(["id", "name", "dosage", "instructions", "createdAt", "discontinuedAt"])
    .select(sql<string[]>`array(select to_char(x, 'HH24:MI') from unnest(times) x order by x)`.as("times"))
    .where("petId", "=", petId);
  if (!includeDiscontinued) q = q.where("discontinuedAt", "is", null);
  return q.orderBy("discontinuedAt", "desc").orderBy("name").execute();
}

export const medicationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:id/medications", { preHandler: app.authorize("pets:read") }, async (req) => {
    const id = idParam(req.params, "Pet");
    return withTenant(app.db, req.auth, async (trx) => ({ items: await listMedications(trx, id, true) }));
  });

  app.post("/:id/medications", { preHandler: app.authorize("pets:write") }, async (req, reply) => {
    const petId = idParam(req.params, "Pet");
    const input = medicationInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const pet = await trx.selectFrom("pets").select("id").where("id", "=", petId).executeTakeFirst();
      if (!pet) throw notFound("Pet");
      const row = await trx.insertInto("petMedications").values({
        organizationId: req.auth.orgId, petId, name: input.name, dosage: input.dosage, instructions: input.instructions,
        times: sql`${input.times}::time[]` as unknown as string[], createdByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "pet.medication_added", entityType: "pet", entityId: petId,
        changes: { medicationId: row.id, name: input.name, dosage: input.dosage, times: input.times } });
      return (await listMedications(trx, petId, true)).find((m) => m.id === row.id)!;
    });
    return reply.status(201).send(created);
  });

  app.post("/:id/medications/:medicationId/discontinue", { preHandler: app.authorize("pets:write") }, async (req) => {
    const petId = idParam(req.params, "Pet");
    const medicationId = idParam({ id: (req.params as { medicationId?: string }).medicationId }, "Medication");
    return withTenant(app.db, req.auth, async (trx) => {
      const res = await trx.updateTable("petMedications")
        .set({ discontinuedAt: new Date(), discontinuedByUserId: req.auth.userId })
        .where("id", "=", medicationId).where("petId", "=", petId).where("discontinuedAt", "is", null)
        .returning("name").executeTakeFirst();
      if (!res) throw new AppError(404, "not_found", "That medication was not found or is already discontinued.");
      await recordAudit(trx, req.auth, { action: "pet.medication_discontinued", entityType: "pet", entityId: petId,
        changes: { medicationId, name: res.name } });
      return { ok: true };
    });
  });
};
