import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, PASSWORD, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
beforeAll(async () => { ctx = await setupTestApp({ LOGIN_MAX_FAILURES_PER_EMAIL: 5, LOGIN_MAX_FAILURES_PER_IP: 12, LOGIN_WINDOW_MINUTES: 15 }); });
afterAll(async () => { await ctx.close(); });

const attempt = (email: string, password: string, ip: string) => ctx.app.inject({
  method: "POST", url: "/api/auth/login", remoteAddress: ip,
  headers: { "x-pawguild-request": "1" }, payload: { email, password },
});

describe("sign-in throttling", () => {
  it("locks an email after 5 failures, even with the right password, and says how long to wait", async () => {
    const org = await createOrg(ctx.ownerDb);
    const email = org.users.owner!.email;
    for (let i = 0; i < 5; i++) expect((await attempt(email, "wrong", "10.0.0.1")).statusCode).toBe(401);
    const locked = await attempt(email, PASSWORD, "10.0.0.1");
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.message).toMatch(/Too many sign-in attempts\. For your security, please wait 15 minutes and try again\./);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(800);
    // The lock follows the email, not the device.
    expect((await attempt(email, PASSWORD, "10.9.9.9")).statusCode).toBe(429);
  });

  it("treats unknown emails exactly like real ones", async () => {
    const ghost = "no-such-person@example.test";
    for (let i = 0; i < 5; i++) expect((await attempt(ghost, "x", "10.0.0.2")).statusCode).toBe(401);
    expect((await attempt(ghost, "x", "10.0.0.2")).statusCode).toBe(429);
  });

  it("unlocks once failures age out of the window", async () => {
    const org = await createOrg(ctx.ownerDb);
    const email = org.users.owner!.email;
    for (let i = 0; i < 5; i++) await attempt(email, "wrong", "10.0.0.3");
    expect((await attempt(email, PASSWORD, "10.0.0.3")).statusCode).toBe(429);
    await ctx.ownerDb.updateTable("loginAttempts").set({ attemptedAt: new Date(Date.now() - 16 * 60_000) }).where("email", "=", email).execute();
    expect((await attempt(email, PASSWORD, "10.0.0.3")).statusCode).toBe(200);
  });

  it("a successful sign-in resets the count, so occasional typos never lock anyone out", async () => {
    const org = await createOrg(ctx.ownerDb);
    const email = org.users.owner!.email;
    // 3 rounds × 3 typos = 9 failures: over the per-email limit if success didn't reset it,
    // but under the per-address limit.
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 3; i++) expect((await attempt(email, "typo", "10.0.0.4")).statusCode).toBe(401);
      expect((await attempt(email, PASSWORD, "10.0.0.4")).statusCode).toBe(200);
    }
  });

  it("limits one address trying many different emails", async () => {
    for (let i = 0; i < 12; i++) expect((await attempt(`spray${i}@example.test`, "x", "10.0.0.5")).statusCode).toBe(401);
    expect((await attempt("spray-new@example.test", "x", "10.0.0.5")).statusCode).toBe(429);
    // Other addresses are unaffected.
    const org = await createOrg(ctx.ownerDb);
    expect((await attempt(org.users.owner!.email, PASSWORD, "10.0.0.6")).statusCode).toBe(200);
  });

  it("doesn't count malformed requests or reveal anything extra when locked", async () => {
    const org = await createOrg(ctx.ownerDb);
    for (let i = 0; i < 10; i++) expect((await attempt("not-an-email", "x", "10.0.0.7")).statusCode).toBe(400);
    expect((await attempt(org.users.owner!.email, PASSWORD, "10.0.0.7")).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) await attempt("nobody2@example.test", "x", "10.0.0.8");
    for (let i = 0; i < 5; i++) await attempt(org.users.owner!.email, "x", "10.0.0.8");
    const a = await attempt("nobody2@example.test", "x", "10.0.0.8");
    const b = await attempt(org.users.owner!.email, "x", "10.0.0.8");
    expect(a.statusCode).toBe(429);
    expect(b.statusCode).toBe(429);
    expect(a.json()).toEqual(b.json());
  });
});
