import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant } from "../db";

/**
 * Operational summary. Reservation, stay and care metrics will be added as those modules land;
 * everything here is computed from live records, never from stored counters.
 */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/summary", { preHandler: app.authorize() }, async (req) => {
    return withTenant(app.db, req.auth, async (trx) => {
      const counts = await trx.selectNoFrom([
        sql<number>`(select count(*) from customers where archived_at is null)::int`.as("activeCustomers"),
        sql<number>`(select count(*) from pets where archived_at is null and status = 'active')::int`.as("activePets"),
      ]).executeTakeFirstOrThrow();

      // Active pets whose latest (non-voided) record for any vaccine expires within 30 days or has expired.
      const vaccinationAlerts = await trx
        .selectFrom("petVaccinations as v")
        .innerJoin("pets as p", "p.id", "v.petId")
        .innerJoin("customers as c", "c.id", "p.customerId")
        .select(["p.id as petId", "p.name as petName", "v.vaccine", "c.firstName", "c.lastName"])
        .select(sql<string>`max(v.expires_on)::text`.as("expiresOn"))
        .where("v.voidedAt", "is", null)
        .where("p.archivedAt", "is", null)
        .where("p.status", "=", "active")
        .groupBy(["p.id", "p.name", "v.vaccine", "c.firstName", "c.lastName"])
        .having(sql`max(v.expires_on)`, "<=", sql`current_date + 30`)
        .orderBy(sql`max(v.expires_on)`)
        .limit(25)
        .execute();

      return {
        ...counts,
        vaccinationAlerts: vaccinationAlerts.map(({ firstName, lastName, ...v }) => ({
          ...v,
          customerName: `${firstName} ${lastName}`,
        })),
      };
    });
  });
};
