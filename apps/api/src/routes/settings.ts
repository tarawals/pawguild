/** Business settings for the signed-in organization. */
import { organizationSettingsInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { fieldError } from "../lib/errors";

const COLUMNS = ["id", "name", "slug", "email", "phone", "timezone", "currency"] as const;

const load = (trx: Tx, orgId: string) =>
  trx.selectFrom("organizations").select([...COLUMNS]).where("id", "=", orgId).executeTakeFirstOrThrow();

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/organization", { preHandler: app.authorize() }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const org = await load(trx, req.auth.orgId);
      // Locations that follow the business's time zone (no zone of their own).
      const following = await trx.selectFrom("locations").select("name").where("timezone", "is", null).where("isActive", "=", true).orderBy("name").execute();
      return { ...org, locationsUsingThisTimezone: following.map((l) => l.name) };
    }));

  app.patch("/organization", { preHandler: app.authorize("settings:manage") }, async (req) => {
    const input = organizationSettingsInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const known = await sql<{ ok: boolean }>`select exists (select 1 from pg_timezone_names where name = ${input.timezone}) as ok`.execute(trx);
      if (!known.rows[0]?.ok) throw fieldError("timezone", "Choose a time zone from the list");
      const before = await load(trx, req.auth.orgId);
      const after = await trx.updateTable("organizations").set(input).where("id", "=", req.auth.orgId)
        .returning([...COLUMNS]).executeTakeFirstOrThrow();
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "organization.updated", entityType: "organization", entityId: req.auth.orgId, changes });
      }
      return after;
    });
  });
};
