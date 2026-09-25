import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db";
import { createOrg, login, setupTestApp } from "./helpers";

/**
 * "Can Organization A accidentally access Organization B's data?" — these tests must stay green.
 */
let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let orgA: Awaited<ReturnType<typeof createOrg>>;
let orgB: Awaited<ReturnType<typeof createOrg>>;
let a: Awaited<ReturnType<typeof login>>;
let b: Awaited<ReturnType<typeof login>>;
let bCustomer: { id: string };
let bPet: { id: string };

beforeAll(async () => {
  ctx = await setupTestApp();
  orgA = await createOrg(ctx.ownerDb);
  orgB = await createOrg(ctx.ownerDb);
  a = await login(ctx.app, orgA.users.owner!.email);
  b = await login(ctx.app, orgB.users.owner!.email);
  bCustomer = (await b.post("/api/customers", { firstName: "Secret", lastName: "Customer", email: "secret@b.example" })).json();
  bPet = (await b.post("/api/pets", { customerId: bCustomer.id, name: "Hidden", species: "cat" })).json();
});
afterAll(async () => { await ctx.close(); });

describe("tenant isolation via the API", () => {
  it("does not list another organization's customers or pets", async () => {
    expect((await a.get("/api/customers?q=Secret")).json().items).toHaveLength(0);
    expect((await a.get("/api/pets?q=Hidden")).json().items).toHaveLength(0);
    expect((await a.get("/api/dashboard/summary")).json().activeCustomers).toBe(0);
  });

  it("returns 404 when reading or modifying another organization's records by id", async () => {
    expect((await a.get(`/api/customers/${bCustomer.id}`)).statusCode).toBe(404);
    expect((await a.patch(`/api/customers/${bCustomer.id}`, { notes: "pwned" })).statusCode).toBe(404);
    expect((await a.post(`/api/customers/${bCustomer.id}/archive`)).statusCode).toBe(404);
    expect((await a.get(`/api/pets/${bPet.id}`)).statusCode).toBe(404);
    expect((await a.patch(`/api/pets/${bPet.id}`, { name: "x" })).statusCode).toBe(404);
    expect((await a.post(`/api/pets/${bPet.id}/vaccinations`, { vaccine: "Rabies", expiresOn: "2030-01-01" })).statusCode).toBe(404);
    const stillIntact = (await b.get(`/api/customers/${bCustomer.id}`)).json();
    expect(stillIntact.notes).toBeNull();
    expect(stillIntact.archivedAt).toBeNull();
  });

  it("cannot attach a pet to another organization's customer", async () => {
    const res = await a.post("/api/pets", { customerId: bCustomer.id, name: "Intruder", species: "dog" });
    expect(res.statusCode).toBe(422);
  });

  it("ignores client-supplied organization ids", async () => {
    const res = await a.post("/api/customers", { firstName: "X", lastName: "Y", organizationId: orgB.orgId });
    expect(res.statusCode).toBe(201);
    const id = res.json().id;
    const row = await ctx.ownerDb.selectFrom("customers").select("organizationId").where("id", "=", id).executeTakeFirstOrThrow();
    expect(row.organizationId).toBe(orgA.orgId);
  });

  it("does not show another organization's audit entries", async () => {
    const items = (await a.get(`/api/audit?entityId=${bCustomer.id}`)).json().items;
    expect(items).toHaveLength(0);
  });
});

describe("tenant isolation in the database (row-level security)", () => {
  it("shows the application role nothing when no organization is set", async () => {
    const rows = await ctx.db.selectFrom("customers").select("id").execute();
    expect(rows).toHaveLength(0);
  });

  it("scopes queries to the organization in the transaction", async () => {
    const rows = await withTenant(ctx.db, { orgId: orgA.orgId, userId: orgA.users.owner!.id }, (trx) =>
      trx.selectFrom("customers").select("id").where("id", "=", bCustomer.id).execute());
    expect(rows).toHaveLength(0);
  });

  it("rejects inserting a row for another organization", async () => {
    await expect(
      withTenant(ctx.db, { orgId: orgA.orgId, userId: orgA.users.owner!.id }, (trx) =>
        trx.insertInto("customers").values({ organizationId: orgB.orgId, firstName: "X", lastName: "Y" }).execute()),
    ).rejects.toThrow(/row-level security/);
  });

  it("does not allow the application role to delete records or rewrite the audit log", async () => {
    const tenant = { orgId: orgB.orgId, userId: orgB.users.owner!.id };
    await expect(withTenant(ctx.db, tenant, (trx) =>
      trx.deleteFrom("customers").where("id", "=", bCustomer.id).execute())).rejects.toThrow(/permission denied/);
    await expect(withTenant(ctx.db, tenant, (trx) =>
      sql`update audit_log set action = 'tampered'`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(ctx.db, tenant, (trx) =>
      sql`delete from audit_log`.execute(trx))).rejects.toThrow(/permission denied/);
  });
});
