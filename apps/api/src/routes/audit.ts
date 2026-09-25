import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenant } from "../db";

const auditQuery = z.object({
  entityType: z.string().max(50).optional(),
  entityId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export const auditRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("audit:read") }, async (req) => {
    const { entityType, entityId, limit, before } = auditQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("auditLog as a").leftJoin("users as u", "u.id", "a.userId")
        .select(["a.id", "a.action", "a.entityType", "a.entityId", "a.changes", "a.createdAt", "u.firstName", "u.lastName"]);
      if (entityType) q = q.where("a.entityType", "=", entityType);
      if (entityId) q = q.where("a.entityId", "=", entityId);
      if (before) q = q.where("a.id", "<", before);
      const items = await q.orderBy("a.id", "desc").limit(limit).execute();
      return {
        items: items.map(({ firstName, lastName, ...rest }) => ({
          ...rest,
          actorName: firstName ? `${firstName} ${lastName}` : null,
        })),
      };
    });
  });
};
