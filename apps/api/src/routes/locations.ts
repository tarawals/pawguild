import { capacityLimitsInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { withTenant } from "../db";
import { recordAudit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { idParam } from "../lib/params";

/** Locations are read-only apart from capacity limits; full location admin comes later. */
export const locationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize() }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const locations = await trx.selectFrom("locations").select(["id", "name", "timezone", "isActive"])
        .where("isActive", "=", true).orderBy("name").execute();
      const limits = await trx.selectFrom("locationCapacities").select(["locationId", "category", "maxPets"]).execute();
      return {
        items: locations.map((l) => {
          const of = (c: string) => limits.find((x) => x.locationId === l.id && x.category === c)?.maxPets ?? null;
          return { ...l, capacity: { daycare: of("daycare"), boarding: of("boarding") } };
        }),
      };
    }),
  );

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
