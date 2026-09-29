import { loginInput, permissionsFor, isRole, ROLE_LABELS } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { DUMMY_HASH_PROMISE, verifyPassword } from "../auth/password";
import { createSession, revokeSession, SESSION_COOKIE } from "../auth/session";
import { checkLoginThrottle, recordLoginAttempt } from "../auth/throttle";
import { withTenant, withUser } from "../db";
import { AppError } from "../lib/errors";

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post("/login", async (req, reply) => {
    const { email, password } = loginInput.parse(req.body);
    const invalid = new AppError(401, "invalid_credentials", "That email and password don't match. Try again.");

    // Throttle before checking the password, so a locked account can't be used to test guesses.
    const throttle = await checkLoginThrottle(app.db, app.config, email, req.ip);
    if (!throttle.allowed) {
      req.log.warn({ reason: "login_throttled", ip: req.ip }, "login throttled");
      const minutes = Math.ceil(throttle.retryAfterSeconds / 60);
      reply.header("retry-after", String(throttle.retryAfterSeconds));
      throw new AppError(429, "too_many_attempts",
        `Too many sign-in attempts. For your security, please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`);
    }

    const user = await app.db
      .selectFrom("users")
      .select(["id", "passwordHash", "isActive"])
      .where("email", "=", email)
      .executeTakeFirst();
    const ok = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));
    if (!user || !ok || !user.isActive) {
      await recordLoginAttempt(app.db, email, req.ip, false);
      req.log.warn({ reason: "invalid_credentials" }, "login failed");
      throw invalid;
    }
    await recordLoginAttempt(app.db, email, req.ip, true);

    // Current phase: a user signs in to their first active organization.
    // TODO(multi-org): let users with several memberships choose an organization.
    const membership = await withUser(app.db, user.id, (trx) =>
      trx
        .selectFrom("memberships")
        .select(["organizationId"])
        .where("userId", "=", user.id)
        .where("isActive", "=", true)
        .orderBy("createdAt")
        .executeTakeFirst(),
    );
    if (!membership) {
      throw new AppError(403, "no_membership", "Your account isn't active for any business. Contact your manager.");
    }

    const { token, expiresAt } = await createSession(
      app.db,
      user.id,
      membership.organizationId,
      app.config.SESSION_TTL_HOURS,
    );
    await app.db.updateTable("users").set({ lastLoginAt: new Date() }).where("id", "=", user.id).execute();
    await withTenant(app.db, { orgId: membership.organizationId, userId: user.id }, (trx) =>
      trx
        .insertInto("auditLog")
        .values({ organizationId: membership.organizationId, userId: user.id, action: "auth.login", entityType: "user", entityId: user.id })
        .execute(),
    );
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: app.config.COOKIE_SECURE,
      path: "/",
      expires: expiresAt,
    });
    return { ok: true };
  });

  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await revokeSession(app.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authorize() }, async (req) => {
    const { auth } = req;
    return withTenant(app.db, auth, async (trx) => {
      const user = await trx
        .selectFrom("users")
        .select(["id", "email", "firstName", "lastName"])
        .where("id", "=", auth.userId)
        .executeTakeFirstOrThrow();
      const org = await trx
        .selectFrom("organizations")
        .select(["id", "name", "timezone", "currency"])
        .where("id", "=", auth.orgId)
        .executeTakeFirstOrThrow();
      if (!isRole(auth.role)) throw new Error("unreachable");
      return {
        user,
        organization: org,
        role: auth.role,
        roleLabel: ROLE_LABELS[auth.role],
        permissions: [...permissionsFor(auth.role)],
      };
    });
  });
};
