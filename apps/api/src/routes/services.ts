import { serviceInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { diff, recordAudit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const COLUMNS = ["id", "name", "category", "description", "priceCents", "priceUnit", "durationMinutes", "isActive", "createdAt", "updatedAt"] as const;

async function getService(trx: Tx, id: string) {
  const row = await trx.selectFrom("services").select(COLUMNS).where("id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Service");
  return row;
}

type Species = "dog" | "cat" | "other";
type Requirements = Record<Species, string[]>;
const SPECIES: Species[] = ["dog", "cat", "other"];

async function loadRequirements(trx: Tx, serviceIds: string[]): Promise<Map<string, Requirements>> {
  const out = new Map<string, Requirements>();
  for (const id of serviceIds) out.set(id, { dog: [], cat: [], other: [] });
  if (serviceIds.length === 0) return out;
  const rows = await trx.selectFrom("serviceVaccineRequirements").select(["serviceId", "species", "vaccine"])
    .where("serviceId", "in", serviceIds).orderBy("vaccine").execute();
  for (const r of rows) out.get(r.serviceId)?.[r.species as Species].push(r.vaccine);
  return out;
}

/** Replace the requirement set for the given species; returns the audit diff. */
async function saveRequirements(trx: Tx, auth: AuthContext, serviceId: string, input: Partial<Requirements>) {
  const before = (await loadRequirements(trx, [serviceId])).get(serviceId)!;
  const changes: Record<string, { from: string[]; to: string[] }> = {};
  for (const species of SPECIES) {
    const wanted = input[species];
    if (!wanted) continue;
    // De-duplicate case-insensitively, keeping the first spelling.
    const seen = new Set<string>();
    const next = wanted.filter((v) => { const k = v.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if ([...next].sort().join("|") === [...before[species]].sort().join("|")) continue;
    await trx.deleteFrom("serviceVaccineRequirements").where("serviceId", "=", serviceId).where("species", "=", species).execute();
    if (next.length > 0) {
      await trx.insertInto("serviceVaccineRequirements")
        .values(next.map((vaccine) => ({ organizationId: auth.orgId, serviceId, species, vaccine }))).execute();
    }
    changes[`vaccines.${species}`] = { from: before[species], to: next };
  }
  return changes;
}

export const serviceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const { includeInactive } = z.object({ includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("services").select(COLUMNS);
      if (!includeInactive) q = q.where("isActive", "=", true);
      const items = await q.orderBy("category").orderBy("name").execute();
      const reqs = await loadRequirements(trx, items.map((i) => i.id));
      return { items: items.map((i) => ({ ...i, vaccineRequirements: reqs.get(i.id)! })) };
    });
  });

  app.post("/", { preHandler: app.authorize("services:manage") }, async (req, reply) => {
    const { vaccineRequirements, ...input } = serviceInput.parse(req.body);
    const row = await withTenant(app.db, req.auth, async (trx) => {
      const created = await trx.insertInto("services").values({ ...input, organizationId: req.auth.orgId })
        .returning(COLUMNS).executeTakeFirstOrThrow();
      const vaccineChanges = vaccineRequirements ? await saveRequirements(trx, req.auth, created.id, vaccineRequirements) : {};
      await recordAudit(trx, req.auth, { action: "service.created", entityType: "service", entityId: created.id,
        changes: { name: created.name, priceCents: created.priceCents, priceUnit: created.priceUnit, ...vaccineChanges } });
      return { ...created, vaccineRequirements: (await loadRequirements(trx, [created.id])).get(created.id)! };
    });
    return reply.status(201).send(row);
  });

  app.patch("/:id", { preHandler: app.authorize("services:manage") }, async (req) => {
    const id = idParam(req.params, "Service");
    const { vaccineRequirements, ...input } = serviceInput.partial().parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await getService(trx, id);
      const after = Object.keys(input).length > 0
        ? await trx.updateTable("services").set(input).where("id", "=", id).returning(COLUMNS).executeTakeFirstOrThrow()
        : before;
      const changes = { ...diff(before, after), ...(vaccineRequirements ? await saveRequirements(trx, req.auth, id, vaccineRequirements) : {}) };
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "service.updated", entityType: "service", entityId: id, changes });
      }
      return { ...after, vaccineRequirements: (await loadRequirements(trx, [id])).get(id)! };
    });
  });
};
