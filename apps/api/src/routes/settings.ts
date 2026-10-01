/** Business settings for the signed-in organization. */
import { billingRulesInput, organizationSettingsInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { getBillingRules } from "../lib/billing-rules";
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

  /** Billing rules are readable by everyone (the booking form uses them for estimates). */
  app.get("/billing", { preHandler: app.authorize() }, async (req) =>
    withTenant(app.db, req.auth, (trx) => getBillingRules(trx, req.auth.orgId)));

  app.put("/billing", { preHandler: app.authorize("settings:manage") }, async (req) => {
    const input = billingRulesInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      for (const [path, id] of [["daycareFullServiceId", input.daycareFullServiceId], ["daycareHalfServiceId", input.daycareHalfServiceId]] as const) {
        if (!id) continue;
        const svc = await trx.selectFrom("services").select(["category", "priceUnit"]).where("id", "=", id).executeTakeFirst();
        if (!svc || svc.category !== "daycare" || svc.priceUnit !== "per_day") throw fieldError(path, "Choose a daycare service priced per day");
      }
      const before = await getBillingRules(trx, req.auth.orgId);
      const values = {
        boardingMode: input.boardingMode, boardingExtraTime: input.boardingExtraTime,
        halfDayMaxMinutes: Math.round(input.halfDayMaxHours * 60), gracePeriodMinutes: input.gracePeriodMinutes,
        daytimeStart: input.daytimeStart, daytimeEnd: input.daytimeEnd,
        daycareFullServiceId: input.daycareFullServiceId, daycareHalfServiceId: input.daycareHalfServiceId,
        additionalPetDiscountBps: input.additionalPetDiscountBps,
      };
      await trx.insertInto("billingSettings").values({ organizationId: req.auth.orgId, ...values })
        .onConflict((oc) => oc.column("organizationId").doUpdateSet(values)).execute();
      const after = await getBillingRules(trx, req.auth.orgId);
      const changes = Object.fromEntries(Object.keys(after).filter((k) => before[k as keyof typeof before] !== after[k as keyof typeof after])
        .map((k) => [k, { from: before[k as keyof typeof before], to: after[k as keyof typeof after] }]));
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "billing_rules.updated", entityType: "organization", entityId: req.auth.orgId, changes });
      }
      return after;
    });
  });
};
