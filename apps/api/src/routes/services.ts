import { serviceInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const COLUMNS = ["id", "name", "category", "description", "priceCents", "priceUnit", "durationMinutes", "isActive", "createdAt", "updatedAt"] as const;

async function getService(trx: Tx, id: string) {
  const row = await trx.selectFrom("services").select(COLUMNS).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Service");
  return row;
}

export const serviceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const { includeInactive } = z.object({ includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("services").select(COLUMNS);
      if (!includeInactive) q = q.where("isActive", "=", true);
      return { items: await q.orderBy("category").orderBy("name").execute() };
    });
  });

  app.post("/", { preHandler: app.authorize("services:manage") }, async (req, reply) => {
    const input = serviceInput.parse(req.body);
    const row = await withTenant(app.db, req.auth, async (trx) => {
      const created = await trx.insertInto("services").values({ ...input, organizationId: req.auth.orgId })
        .returning(COLUMNS).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "service.created", entityType: "service", entityId: created.id,
        changes: { name: created.name, priceCents: created.priceCents, priceUnit: created.priceUnit } });
      return created;
    });
    return reply.status(201).send(row);
  });

  app.patch("/:id", { preHandler: app.authorize("services:manage") }, async (req) => {
    const id = idParam(req.params, "Service");
    const input = serviceInput.partial().parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getService(trx, id);
      const after = await trx.updateTable("services").set(input).where("id", "=", id).returning(COLUMNS).executeTakeFirstOrThrow();
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "service.updated", entityType: "service", entityId: id, changes });
      }
      return after;
    });
  });
};
