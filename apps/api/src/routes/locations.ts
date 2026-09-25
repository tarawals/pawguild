import type { FastifyPluginAsync } from "fastify";
import { withTenant } from "../db";

/** Read-only for now; location management arrives with the admin module. */
export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize() }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => ({
      items: await trx.selectFrom("locations")
        .select(["id", "name", "timezone", "daycareCapacity", "isActive"])
        .where("isActive", "=", true).orderBy("name").execute(),
    })),
  );
};
