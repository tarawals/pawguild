import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe("authentication", () => {
  it("signs in, returns the session identity, and signs out", async () => {
    const { users, orgId } = await createOrg(ctx.ownerDb, ["front_desk"]);
    const client = await login(ctx.app, users.front_desk!.email);
    const me = await client.get("/api/auth/me");
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: "front_desk", organization: { id: orgId } });
    expect(me.json().permissions).toContain("customers:write");

    expect((await client.post("/api/auth/logout")).statusCode).toBe(200);
    expect((await client.get("/api/auth/me")).statusCode).toBe(401);
  });

  it("rejects wrong passwords and unknown emails with the same error", async () => {
    const { users } = await createOrg(ctx.ownerDb);
    const post = (email: string, password: string) =>
      ctx.app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-pawguild-request": "1" }, payload: { email, password } });
    const wrong = await post(users.owner!.email, "nope");
    const unknown = await post("nobody@example.test", "nope");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("blocks state-changing requests without the CSRF header", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "a@b.co", password: "x" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("csrf");
  });

  it("requires a session for protected routes", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/api/customers" });
    expect(res.statusCode).toBe(401);
  });

  it("stops accepting a session once the membership is deactivated", async () => {
    const { users, orgId } = await createOrg(ctx.ownerDb, ["manager"]);
    const client = await login(ctx.app, users.manager!.email);
    await ctx.ownerDb.updateTable("memberships").set({ isActive: false }).where("organizationId", "=", orgId).execute();
    expect((await client.get("/api/customers")).statusCode).toBe(401);
  });
});

describe("permissions", () => {
  it("prevents a care attendant from creating customers or reading audit history", async () => {
    const { users } = await createOrg(ctx.ownerDb, ["care_attendant"]);
    const client = await login(ctx.app, users.care_attendant!.email);
    expect((await client.get("/api/customers")).statusCode).toBe(200);
    const res = await client.post("/api/customers", { firstName: "A", lastName: "B" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/permission/);
    expect((await client.get("/api/audit")).statusCode).toBe(403);
  });
});
