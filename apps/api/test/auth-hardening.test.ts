import { ROLES } from "@pawguild/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "../src/auth/session";
import { createOrg, login, PASSWORD, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

const rawLogin = (payload: unknown, headers: Record<string, string> = { "x-pawguild-request": "1" }) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: payload as object });

describe("sign-in", () => {
  it("works for every role and reports that role", async () => {
    const org = await createOrg(ctx.ownerDb, [...ROLES]);
    for (const role of ROLES) {
      const client = await login(ctx.app, org.users[role]!.email);
      const me = (await client.get("/api/auth/me")).json();
      expect(me.role).toBe(role);
      expect(me.organization.id).toBe(org.orgId);
    }
  });

  it("accepts email in any letter case and with surrounding spaces trimmed by the form", async () => {
    const org = await createOrg(ctx.ownerDb);
    const res = await rawLogin({ email: org.users.owner!.email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it("sets a secure session cookie (HttpOnly, SameSite=Lax, path /, expiry) and never returns the token in the body", async () => {
    const org = await createOrg(ctx.ownerDb);
    const res = await rawLogin({ email: org.users.owner!.email, password: PASSWORD });
    const cookie = res.cookies.find((c) => c.name === "pawguild_session")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Lax");
    expect(cookie.path).toBe("/");
    expect(cookie.expires).toBeInstanceOf(Date);
    expect(cookie.value.length).toBeGreaterThanOrEqual(40);
    expect(res.body).not.toContain(cookie.value);
    // Only a hash of the token is stored.
    const stored = await ctx.ownerDb.selectFrom("sessions").select("tokenHash").where("tokenHash", "=", hashToken(cookie.value)).executeTakeFirst();
    expect(stored).toBeDefined();
    const plain = await ctx.ownerDb.selectFrom("sessions").select("id").where("tokenHash", "=", cookie.value).executeTakeFirst();
    expect(plain).toBeUndefined();
  });

  it("gives the same answer for a wrong password, an unknown email and a deactivated user", async () => {
    const org = await createOrg(ctx.ownerDb, ["owner", "front_desk"]);
    await ctx.ownerDb.updateTable("users").set({ isActive: false }).where("id", "=", org.users.front_desk!.id).execute();
    const bodies = await Promise.all([
      rawLogin({ email: org.users.owner!.email, password: "wrong" }),
      rawLogin({ email: "nobody-here@example.test", password: "wrong" }),
      rawLogin({ email: org.users.front_desk!.email, password: PASSWORD }),
    ]);
    for (const b of bodies) expect(b.statusCode).toBe(401);
    expect(new Set(bodies.map((b) => b.body)).size).toBe(1);
  });

  it("refuses staff whose membership was deactivated, with a clear message", async () => {
    const org = await createOrg(ctx.ownerDb, ["groomer"]);
    await ctx.ownerDb.updateTable("memberships").set({ isActive: false }).where("userId", "=", org.users.groomer!.id).execute();
    const res = await rawLogin({ email: org.users.groomer!.email, password: PASSWORD });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/isn't active for any business/);
  });

  it("validates input and never leaks internals", async () => {
    for (const payload of [{}, { email: "not-an-email", password: "x" }, { email: "a@b.co" }, { email: "a@b.co", password: "" }, "garbage"]) {
      const res = await rawLogin(payload);
      expect([400, 415]).toContain(res.statusCode);
      expect(res.body).not.toMatch(/stack|node_modules|select |kysely|pg_/i);
    }
  });

  it("is not injectable through the email field", async () => {
    const org = await createOrg(ctx.ownerDb);
    for (const email of [`${org.users.owner!.email}' OR '1'='1`, `' OR 1=1 --@x.co`, `${org.users.owner!.email}'--`]) {
      const res = await rawLogin({ email, password: "anything" });
      expect([400, 401]).toContain(res.statusCode);
    }
    expect(await ctx.ownerDb.selectFrom("users").select("id").where("id", "=", org.users.owner!.id).executeTakeFirst()).toBeDefined();
  });

  it("requires the CSRF header even with valid credentials", async () => {
    const org = await createOrg(ctx.ownerDb);
    expect((await rawLogin({ email: org.users.owner!.email, password: PASSWORD }, {})).statusCode).toBe(403);
  });

  it("allows several simultaneous sessions (e.g. desk PC and tablet) and signs out only the current one", async () => {
    const org = await createOrg(ctx.ownerDb);
    const pc = await login(ctx.app, org.users.owner!.email);
    const tablet = await login(ctx.app, org.users.owner!.email);
    await pc.post("/api/auth/logout");
    expect((await pc.get("/api/auth/me")).statusCode).toBe(401);
    expect((await tablet.get("/api/auth/me")).statusCode).toBe(200);
  });
});

describe("sessions", () => {
  async function sessionFor(role = "owner" as const) {
    const org = await createOrg(ctx.ownerDb, [role]);
    const res = await rawLogin({ email: org.users[role]!.email, password: PASSWORD });
    const token = res.cookies.find((c) => c.name === "pawguild_session")!.value;
    const get = (url: string) => ctx.app.inject({ method: "GET", url, headers: { cookie: `pawguild_session=${token}` } });
    return { org, token, get };
  }

  it("rejects expired sessions", async () => {
    const s = await sessionFor();
    await ctx.ownerDb.updateTable("sessions").set({ expiresAt: new Date(Date.now() - 1000) }).where("tokenHash", "=", hashToken(s.token)).execute();
    const res = await s.get("/api/customers");
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("Your session has ended. Please sign in again.");
  });

  it("rejects revoked sessions and forged or tampered cookies", async () => {
    const s = await sessionFor();
    const tampered = await ctx.app.inject({ method: "GET", url: "/api/customers", headers: { cookie: `pawguild_session=${s.token.slice(0, -2)}xx` } });
    expect(tampered.statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/api/customers", headers: { cookie: "pawguild_session=" } })).statusCode).toBe(401);
    await ctx.ownerDb.updateTable("sessions").set({ revokedAt: new Date() }).where("tokenHash", "=", hashToken(s.token)).execute();
    expect((await s.get("/api/customers")).statusCode).toBe(401);
  });

  it("stops working immediately when the user is deactivated mid-session", async () => {
    const s = await sessionFor();
    expect((await s.get("/api/customers")).statusCode).toBe(200);
    await ctx.ownerDb.updateTable("users").set({ isActive: false }).where("email", "like", "owner-%").where("id", "in",
      ctx.ownerDb.selectFrom("memberships").select("userId").where("organizationId", "=", s.org.orgId)).execute();
    expect((await s.get("/api/customers")).statusCode).toBe(401);
  });

  it("picks up a role change on the very next request (no stale permissions)", async () => {
    const s = await sessionFor("manager" as never);
    expect((await s.get("/api/audit")).statusCode).toBe(200);
    await ctx.ownerDb.updateTable("memberships").set({ role: "care_attendant" }).where("organizationId", "=", s.org.orgId).execute();
    expect((await s.get("/api/audit")).statusCode).toBe(403);
  });

  it("records sign-ins in the audit log and updates last sign-in time", async () => {
    const org = await createOrg(ctx.ownerDb);
    await login(ctx.app, org.users.owner!.email);
    const u = await ctx.ownerDb.selectFrom("users").select("lastLoginAt").where("id", "=", org.users.owner!.id).executeTakeFirstOrThrow();
    expect(u.lastLoginAt).not.toBeNull();
    const a = await ctx.ownerDb.selectFrom("auditLog").select("action").where("organizationId", "=", org.orgId).where("action", "=", "auth.login").execute();
    expect(a.length).toBe(1);
  });
});
