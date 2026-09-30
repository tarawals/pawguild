import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let admin: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["administrator", "manager"]);
  admin = await login(ctx.app, org.users.administrator!.email);
  manager = await login(ctx.app, org.users.manager!.email);
});
afterAll(async () => { await ctx.close(); });

describe("business settings", () => {
  it("anyone can read them, including which locations follow the business's time zone", async () => {
    const s = (await manager.get("/api/settings/organization")).json();
    expect(s).toMatchObject({ id: org.orgId, timezone: "America/New_York", currency: "USD", locationsUsingThisTimezone: ["Main"] });
  });

  it("owners and administrators edit name, contact details and time zone; it's audited", async () => {
    expect((await manager.patch("/api/settings/organization", { name: "X", timezone: "America/Chicago" })).statusCode).toBe(403);
    const res = await admin.patch("/api/settings/organization", {
      name: "  Paws & Claws Resort ", email: "Front@PawsClaws.example", phone: "555-0199", timezone: "America/Chicago",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Paws & Claws Resort", email: "front@pawsclaws.example", phone: "555-0199", timezone: "America/Chicago", currency: "USD" });
    expect((await manager.get("/api/auth/me")).json().organization).toMatchObject({ name: "Paws & Claws Resort", timezone: "America/Chicago" });
    const audit = (await admin.get(`/api/audit?entityType=organization&entityId=${org.orgId}`)).json().items[0];
    expect(audit).toMatchObject({ action: "organization.updated", changes: { timezone: { from: "America/New_York", to: "America/Chicago" } } });
    // Saving the same values again records nothing new.
    await admin.patch("/api/settings/organization", { name: "Paws & Claws Resort", email: "front@pawsclaws.example", phone: "555-0199", timezone: "America/Chicago" });
    expect((await admin.get(`/api/audit?entityType=organization&entityId=${org.orgId}`)).json().items).toHaveLength(1);
  });

  it("validates input and ignores fields that can't be changed", async () => {
    const bad = await admin.patch("/api/settings/organization", { name: " ", email: "nope", timezone: "EST" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["email", "name", "timezone"]);
    expect((await admin.patch("/api/settings/organization", { name: "Paws", timezone: "Mars/Base" })).statusCode).toBe(400);
    const res = await admin.patch("/api/settings/organization", { name: "Paws", timezone: "America/Chicago", currency: "EUR", slug: "hijack" });
    expect(res.json()).toMatchObject({ currency: "USD", slug: expect.stringMatching(/^test-/) });
  });

  it("the database only lets a request update its own organization, even for someone in two", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    // The administrator also belongs to the other organization.
    await ctx.ownerDb.insertInto("memberships").values({ organizationId: other.orgId, userId: org.users.administrator!.id, role: "owner" }).execute();
    const tenant = { orgId: org.orgId, userId: org.users.administrator!.id };
    const visible = await withTenant(ctx.db, tenant, (trx) => sql<{ n: number }>`select count(*)::int as n from organizations where id = ${other.orgId}`.execute(trx));
    expect(visible.rows[0]!.n).toBe(1); // members may still see their other organizations
    const updated = await withTenant(ctx.db, tenant, (trx) => sql`update organizations set name = 'Hijacked' where id = ${other.orgId}`.execute(trx));
    expect(Number(updated.numAffectedRows)).toBe(0);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`update organizations set currency = 'EUR' where id = ${org.orgId}`.execute(trx)))
      .rejects.toThrow(/permission denied/);
    const theirs = await ctx.ownerDb.selectFrom("organizations").select("name").where("id", "=", other.orgId).executeTakeFirstOrThrow();
    expect(theirs.name).not.toBe("Hijacked");
  });
});
