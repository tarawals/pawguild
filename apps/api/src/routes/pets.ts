import { listQuery, petInput, petUpdateInput, vaccinationInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { AppError, notFound } from "../lib/errors";
import { idParam, likePattern } from "../lib/params";

const PET_COLUMNS = [
  "id", "customerId", "name", "species", "breed", "sex", "isFixed", "dateOfBirth",
  "dateOfBirthIsEstimate", "weightGrams", "color", "temperament", "behaviorNotes", "medicalNotes",
  "allergies", "feedingInstructions", "specialInstructions", "veterinarianName",
  "veterinarianPhone", "status", "archivedAt", "createdAt", "updatedAt",
] as const;

async function getPet(trx: Tx, id: string) {
  const row = await trx.selectFrom("pets").select(PET_COLUMNS).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Pet");
  return row;
}

const petListQuery = listQuery.extend({ customerId: z.uuid().optional() });

export const petRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("pets:read") }, async (req) => {
    const { q, includeArchived, limit, offset, customerId } = petListQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let query = trx.selectFrom("pets as p").innerJoin("customers as c", "c.id", "p.customerId");
      if (!includeArchived) query = query.where("p.archivedAt", "is", null);
      if (customerId) query = query.where("p.customerId", "=", customerId);
      if (q) query = query.where("p.name", "ilike", likePattern(q));
      const [{ total }] = (await query.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
      const items = await query
        .select(["p.id", "p.name", "p.species", "p.breed", "p.status", "p.archivedAt", "p.customerId"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .orderBy(sql`lower(p.name)`).orderBy("p.id")
        .limit(limit).offset(offset).execute();
      return { items, total };
    });
  });

  app.post("/", { preHandler: app.authorize("pets:write") }, async (req, reply) => {
    const input = petInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const owner = await trx.selectFrom("customers").select(["id", "archivedAt"])
        .where("id", "=", input.customerId).executeTakeFirst();
      if (!owner) throw new AppError(422, "invalid_reference", "That customer was not found.");
      if (owner.archivedAt) throw new AppError(422, "customer_archived", "Restore this customer before adding pets.");
      const row = await trx.insertInto("pets").values({ ...input, organizationId: req.auth.orgId })
        .returning(PET_COLUMNS).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "pet.created", entityType: "pet", entityId: row.id });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.get("/:id", { preHandler: app.authorize("pets:read") }, async (req) => {
    const id = idParam(req.params, "Pet");
    return withTenant(app.db, req.auth, async (trx) => {
      const pet = await getPet(trx, id);
      const owner = await trx.selectFrom("customers")
        .select(["id", "firstName", "lastName", "phone", "email", "emergencyContactName", "emergencyContactPhone"])
        .where("id", "=", pet.customerId).executeTakeFirstOrThrow();
      const vaccinations = await trx.selectFrom("petVaccinations")
        .select(["id", "vaccine", "administeredOn", "expiresOn", "notes", "createdAt"])
        .where("petId", "=", id).where("voidedAt", "is", null)
        .orderBy("vaccine").orderBy("expiresOn", "desc").execute();
      return { ...pet, owner, vaccinations };
    });
  });

  app.patch("/:id", { preHandler: app.authorize("pets:write") }, async (req) => {
    const id = idParam(req.params, "Pet");
    const input = petUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getPet(trx, id);
      const after = await trx.updateTable("pets").set(input).where("id", "=", id)
        .returning(PET_COLUMNS).executeTakeFirstOrThrow();
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "pet.updated", entityType: "pet", entityId: id, changes });
      }
      return after;
    });
  });

  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    app.post(`/:id/${action}`, { preHandler: app.authorize("pets:write") }, async (req) => {
      const id = idParam(req.params, "Pet");
      return withTenant(app.db, req.auth, async (trx) => {
        await getPet(trx, id);
        const row = await trx.updateTable("pets").set({ archivedAt: archived ? new Date() : null })
          .where("id", "=", id).returning(PET_COLUMNS).executeTakeFirstOrThrow();
        await recordAudit(trx, req.auth, { action: `pet.${action}d`, entityType: "pet", entityId: id });
        return row;
      });
    });
  }

  app.post("/:id/vaccinations", { preHandler: app.authorize("pets:write") }, async (req, reply) => {
    const id = idParam(req.params, "Pet");
    const input = vaccinationInput.parse(req.body);
    const row = await withTenant(app.db, req.auth, async (trx) => {
      await getPet(trx, id);
      const v = await trx.insertInto("petVaccinations")
        .values({ ...input, petId: id, organizationId: req.auth.orgId, recordedByUserId: req.auth.userId })
        .returning(["id", "vaccine", "administeredOn", "expiresOn", "notes", "createdAt"])
        .executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, {
        action: "pet.vaccination_recorded", entityType: "pet", entityId: id,
        changes: { vaccinationId: v.id, vaccine: v.vaccine, expiresOn: v.expiresOn },
      });
      return v;
    });
    return reply.status(201).send(row);
  });

  app.post("/:id/vaccinations/:vaccinationId/void", { preHandler: app.authorize("pets:write") }, async (req) => {
    const id = idParam(req.params, "Pet");
    const vaccinationId = idParam({ id: (req.params as { vaccinationId?: string }).vaccinationId }, "Vaccination record");
    return withTenant(app.db, req.auth, async (trx) => {
      const res = await trx.updateTable("petVaccinations")
        .set({ voidedAt: new Date(), voidedByUserId: req.auth.userId })
        .where("id", "=", vaccinationId).where("petId", "=", id).where("voidedAt", "is", null)
        .executeTakeFirst();
      if (res.numUpdatedRows === 0n) throw notFound("Vaccination record");
      await recordAudit(trx, req.auth, {
        action: "pet.vaccination_voided", entityType: "pet", entityId: id, changes: { vaccinationId },
      });
      return { ok: true };
    });
  });
};
