import { randomBytes } from "node:crypto";
import type { Role } from "@pawguild/shared";
import { buildApp } from "../src/app";
import { hashPassword } from "../src/auth/password";
import type { Config } from "../src/config";
import { createDb, type Db } from "../src/db";
import { TEST_APP_ROLE, TEST_APP_URL, TEST_OWNER_URL } from "./env";

export const PASSWORD = "correct horse battery staple";
let hash: Promise<string> | undefined;

export const config: Config = {
  NODE_ENV: "test",
  PORT: 0,
  HOST: "127.0.0.1",
  DATABASE_URL: TEST_APP_URL,
  MIGRATION_DATABASE_URL: TEST_OWNER_URL,
  APP_DB_ROLE: TEST_APP_ROLE,
  SESSION_TTL_HOURS: 1,
  COOKIE_SECURE: false,
  WEB_ORIGIN: undefined,
};

export async function setupTestApp() {
  const db = createDb(TEST_APP_URL);
  const ownerDb = createDb(TEST_OWNER_URL);
  const app = await buildApp({ db, config });
  return {
    app,
    ownerDb,
    db,
    async close() {
      await app.close();
      await db.destroy();
      await ownerDb.destroy();
    },
  };
}

/** Create an organization with one staff user per requested role (as schema owner, bypassing RLS). */
export async function createOrg(ownerDb: Db, roles: Role[] = ["owner"]) {
  const suffix = randomBytes(4).toString("hex");
  hash ??= hashPassword(PASSWORD);
  const passwordHash = await hash;
  const org = await ownerDb.insertInto("organizations")
    .values({ name: `Test Org ${suffix}`, slug: `test-${suffix}` }).returning("id").executeTakeFirstOrThrow();
  const users: Record<string, { id: string; email: string }> = {};
  for (const role of roles) {
    const email = `${role}-${suffix}@example.test`;
    const user = await ownerDb.insertInto("users")
      .values({ email, passwordHash, firstName: role, lastName: "Tester" }).returning("id").executeTakeFirstOrThrow();
    await ownerDb.insertInto("memberships").values({ organizationId: org.id, userId: user.id, role }).execute();
    users[role] = { id: user.id, email };
  }
  return { orgId: org.id, users };
}

type App = Awaited<ReturnType<typeof setupTestApp>>["app"];

/** Log in and return a small client that sends the session cookie and CSRF header. */
export async function login(app: App, email: string, password = PASSWORD) {
  const res = await app.inject({
    method: "POST", url: "/api/auth/login",
    headers: { "x-pawguild-request": "1" }, payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === "pawguild_session")!;
  const headers = { cookie: `pawguild_session=${cookie.value}`, "x-pawguild-request": "1" };
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) =>
    app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return {
    get: (url: string) => call("GET", url),
    post: (url: string, payload: unknown = {}) => call("POST", url, payload),
    patch: (url: string, payload: unknown) => call("PATCH", url, payload),
  };
}
