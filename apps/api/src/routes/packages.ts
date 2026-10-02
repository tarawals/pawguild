/**
 * Prepaid daycare packages: the packages a business sells (owners and administrators set them up,
 * including how long they last), selling one to a customer on an invoice, and each customer's
 * balance. Days are used automatically when daycare is invoiced (see lib/packages.ts).
 */
import { addDays, calendarDate, packageProductInput, packageProductUpdateInput, sellPackageInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import { diff, recordAudit } from "../lib/audit";
import { fieldError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";
import { packageBalances } from "../lib/packages";
import { createDraft, issueInvoice } from "./billing";

const COLUMNS = ["id", "name", "covers", "days", "priceCents", "expiresAfterDays", "isTaxable", "isActive"] as const;
const listQuery = z.object({ includeInactive: z.enum(["true", "false"]).optional() });

async function orgToday(trx: Tx, orgId: string) {
  const { timezone } = await trx.selectFrom("organizations").select("timezone").where("id", "=", orgId).executeTakeFirstOrThrow();
  return { timezone, today: calendarDate(new Date(), timezone) };
}

export const packageRoutes: FastifyPluginAsync = async (app) => {
  app.get("/package-products", { preHandler: app.authorize("billing:read") }, async (req) => {
    const { includeInactive } = listQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("packageProducts").select([...COLUMNS]).orderBy("isActive", "desc").orderBy("name");
      if (includeInactive !== "true") q = q.where("isActive", "=", true);
      return { items: (await q.execute()).map((p) => ({ ...p, priceCents: Number(p.priceCents) })) };
    });
  });

  app.post("/package-products", { preHandler: app.authorize("settings:manage") }, async (req, reply) => {
    const input = packageProductInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const dup = await trx.selectFrom("packageProducts").select("id").where("name", "=", input.name).executeTakeFirst();
      if (dup) throw fieldError("name", "There's already a package with this name");
      const row = await trx.insertInto("packageProducts").values({ organizationId: req.auth.orgId, ...input })
        .returning([...COLUMNS]).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "package_product.created", entityType: "package_product", entityId: row.id, changes: input });
      return { ...row, priceCents: Number(row.priceCents) };
    });
    return reply.status(201).send(created);
  });

  /** Changes apply to packages sold from now on; packages already sold keep their terms. */
  app.patch("/package-products/:id", { preHandler: app.authorize("settings:manage") }, async (req) => {
    const id = idParam(req.params, "Package");
    const input = packageProductUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("packageProducts").select([...COLUMNS]).where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!before) throw notFound("Package");
      if (input.name && input.name !== before.name) {
        const dup = await trx.selectFrom("packageProducts").select("id").where("name", "=", input.name).where("id", "<>", id).executeTakeFirst();
        if (dup) throw fieldError("name", "There's already a package with this name");
      }
      if (Object.keys(input).length === 0) return { ...before, priceCents: Number(before.priceCents) };
      const after = await trx.updateTable("packageProducts").set(input).where("id", "=", id).returning([...COLUMNS]).executeTakeFirstOrThrow();
      const changes = diff({ ...before, priceCents: Number(before.priceCents) }, { ...after, priceCents: Number(after.priceCents) });
      if (Object.keys(changes).length) await recordAudit(trx, req.auth, { action: "package_product.updated", entityType: "package_product", entityId: id, changes });
      return { ...after, priceCents: Number(after.priceCents) };
    });
  });

  app.get("/customers/:id/packages", { preHandler: app.authorize("billing:read") }, async (req) => {
    const customerId = idParam(req.params, "Customer");
    return withTenant(app.db, req.auth, async (trx) => {
      const customer = await trx.selectFrom("customers").select("id").where("id", "=", customerId).executeTakeFirst();
      if (!customer) throw notFound("Customer");
      const { today } = await orgToday(trx, req.auth.orgId);
      const items = await packageBalances(trx, customerId, today);
      const uses = items.length === 0 ? [] : await trx.selectFrom("packageRedemptions as r").innerJoin("invoices as i", "i.id", "r.invoiceId")
        .select(["r.customerPackageId", "r.usedOn", "r.invoiceId", "r.reservationId", "i.status as invoiceStatus"])
        .where("r.customerPackageId", "in", items.map((p) => p.id)).orderBy("r.usedOn").execute();
      return {
        items: items.map((p) => ({ ...p, uses: uses.filter((u) => u.customerPackageId === p.id).map(({ customerPackageId: _, ...u }) => u) })),
      };
    });
  });

  /** Sell a package: an issued invoice for it, and the package on the customer's account. */
  app.post("/customers/:id/packages", { preHandler: app.authorize("billing:write") }, async (req, reply) => {
    const customerId = idParam(req.params, "Customer");
    const input = sellPackageInput.parse(req.body);
    const result = await withTenant(app.db, req.auth, async (trx) => {
      const customer = await trx.selectFrom("customers").select(["id", "archivedAt"]).where("id", "=", customerId).executeTakeFirst();
      if (!customer || customer.archivedAt) throw notFound("Customer");
      const product = await trx.selectFrom("packageProducts").select([...COLUMNS]).where("id", "=", input.productId).executeTakeFirst();
      if (!product) throw fieldError("productId", "Choose a package");
      if (!product.isActive) throw fieldError("productId", "That package is no longer sold");
      let lq = trx.selectFrom("locations").select("id").where("isActive", "=", true).orderBy("name");
      if (input.locationId) lq = lq.where("id", "=", input.locationId);
      const location = await lq.executeTakeFirst();
      if (!location) throw fieldError("locationId", "Choose a location");
      const { today } = await orgToday(trx, req.auth.orgId);
      const invoiceId = await createDraft(trx, req.auth, { customerId, locationId: location.id });
      const kind = product.covers === "full_day" ? "full" : "half";
      await trx.insertInto("invoiceLines").values({
        organizationId: req.auth.orgId, invoiceId, serviceId: null, quantity: 1, unitPriceCents: Number(product.priceCents), discountCents: 0,
        taxable: product.isTaxable, position: 0,
        description: `${product.name} — ${product.days} ${kind} day${product.days === 1 ? "" : "s"} of daycare${product.expiresAfterDays ? `, use by ${new Date(`${addDays(today, product.expiresAfterDays)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}` : ""}`,
      }).execute();
      await issueInvoice(trx, req.auth, invoiceId);
      const pkg = await trx.insertInto("customerPackages").values({
        organizationId: req.auth.orgId, customerId, productId: product.id, name: product.name, covers: product.covers, days: product.days,
        priceCents: Number(product.priceCents), expiresOn: product.expiresAfterDays ? addDays(today, product.expiresAfterDays) : null,
        invoiceId, soldByUserId: req.auth.userId,
      }).returning("id").executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "package.sold", entityType: "customer", entityId: customerId,
        changes: { packageId: pkg.id, product: product.name, days: product.days, priceCents: Number(product.priceCents), invoiceId } });
      return { packageId: pkg.id, invoiceId, package: (await packageBalances(trx, customerId, today)).find((p) => p.id === pkg.id) };
    });
    return reply.status(201).send(result);
  });
};

