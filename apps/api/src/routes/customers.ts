import { customerInput, listQuery } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { idParam, likePattern } from "../lib/params";
import { customerBalance, customerCredit } from "./billing";

const CUSTOMER_COLUMNS = [
  "id", "firstName", "lastName", "email", "phone", "altPhone", "addressLine1", "addressLine2",
  "city", "region", "postalCode", "country", "emergencyContactName", "emergencyContactPhone",
  "notes", "status", "emailOptIn", "smsOptIn", "archivedAt", "createdAt", "updatedAt",
] as const;

async function getCustomer(trx: Tx, id: string) {
  const row = await trx.selectFrom("customers").select(CUSTOMER_COLUMNS).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Customer");
  return row;
}

export const customerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("customers:read") }, async (req) => {
    const { q, includeArchived, limit, offset } = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let query = trx.selectFrom("customers as c");
      if (!includeArchived) query = query.where("c.archivedAt", "is", null);
      if (q) {
        const p = likePattern(q);
        query = query.where((eb) =>
          eb.or([
            eb(sql`c.first_name || ' ' || c.last_name`, "ilike", p),
            eb("c.email", "ilike", p),
            eb("c.phone", "ilike", p),
            eb.exists(
              eb.selectFrom("pets as p").select("p.id")
                .whereRef("p.customerId", "=", "c.id").where("p.name", "ilike", p),
            ),
          ]),
        );
      }
      const [{ total }] = (await query.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
      const items = await query
        .select(["c.id", "c.firstName", "c.lastName", "c.email", "c.phone", "c.status", "c.archivedAt"])
        .select(sql<string[]>`coalesce((select array_agg(p.name order by p.name) from pets p
                 where p.customer_id = c.id and p.archived_at is null), '{}')`.as("petNames"))
        .orderBy(sql`lower(c.last_name)`).orderBy(sql`lower(c.first_name)`).orderBy("c.id")
        .limit(limit).offset(offset)
        .execute();
      return { items, total };
    });
  });

  app.post("/", { preHandler: app.authorize("customers:write") }, async (req, reply) => {
    const input = customerInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const row = await trx
        .insertInto("customers")
        .values({ ...input, organizationId: req.auth.orgId })
        .returning(CUSTOMER_COLUMNS)
        .executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "customer.created", entityType: "customer", entityId: row.id });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.get("/:id", { preHandler: app.authorize("customers:read") }, async (req) => {
    const id = idParam(req.params, "Customer");
    return withTenant(app.db, req.auth, async (trx) => {
      const customer = await getCustomer(trx, id);
      const pets = await trx
        .selectFrom("pets")
        .select(["id", "name", "species", "breed", "status", "archivedAt"])
        .where("customerId", "=", id)
        .orderBy("name")
        .execute();
      const billing = req.auth.permissions.has("billing:read")
        ? { ...(await customerBalance(trx, id)), creditCents: await customerCredit(trx, id) }
        : null;
      return { ...customer, pets, billing };
    });
  });

  app.patch("/:id", { preHandler: app.authorize("customers:write") }, async (req) => {
    const id = idParam(req.params, "Customer");
    const input = customerInput.partial().parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getCustomer(trx, id);
      const after = await trx.updateTable("customers").set(input).where("id", "=", id)
        .returning(CUSTOMER_COLUMNS).executeTakeFirstOrThrow();
      const changes = diff(before, after);
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "customer.updated", entityType: "customer", entityId: id, changes });
      }
      return after;
    });
  });

  for (const [action, archived] of [["archive", true], ["restore", false]] as const) {
    app.post(`/:id/${action}`, { preHandler: app.authorize("customers:write") }, async (req) => {
      const id = idParam(req.params, "Customer");
      return withTenant(app.db, req.auth, async (trx) => {
        await getCustomer(trx, id);
        const row = await trx.updateTable("customers")
          .set({ archivedAt: archived ? new Date() : null })
          .where("id", "=", id).returning(CUSTOMER_COLUMNS).executeTakeFirstOrThrow();
        await recordAudit(trx, req.auth, { action: `customer.${action}d`, entityType: "customer", entityId: id });
        return row;
      });
    });
  }
};
