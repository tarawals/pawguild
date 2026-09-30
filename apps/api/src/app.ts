import cookie from "@fastify/cookie";
import { isRole, permissionsFor, type Permission } from "@pawguild/shared";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { findSession, SESSION_COOKIE } from "./auth/session";
import type { Config } from "./config";
import { withTenant, type Db } from "./db";
import type { AuthContext } from "./lib/auth-context";
import { AppError, forbidden, unauthenticated } from "./lib/errors";
import { auditRoutes } from "./routes/audit";
import { authRoutes } from "./routes/auth";
import { billingRoutes } from "./routes/billing";
import { careRoutes } from "./routes/care";
import { incidentRoutes } from "./routes/incidents";
import { medicationRoutes } from "./routes/medications";
import { customerRoutes } from "./routes/customers";
import { employeeRoutes } from "./routes/employees";
import { dashboardRoutes } from "./routes/dashboard";
import { locationRoutes } from "./routes/locations";
import { petRoutes } from "./routes/pets";
import { reportRoutes } from "./routes/reports";
import { groomingRoutes } from "./routes/grooming";
import { shiftRoutes } from "./routes/shifts";
import { reservationRoutes } from "./routes/reservations";
import { resourceRoutes } from "./routes/resources";
import { serviceRoutes } from "./routes/services";

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    config: Config;
    /** preHandler: require a signed-in staff user, optionally with a permission. */
    authorize: (permission?: Permission) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AuthContext;
  }
}

/** Routes usable while a temporary password is still in place. */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/auth/me", "/api/auth/change-password", "/api/auth/logout"]);

const PG_ERROR_MESSAGES: Record<string, [number, string, string]> = {
  "23505": [409, "conflict", "That conflicts with an existing record (for example a duplicate email)."],
  "23503": [422, "invalid_reference", "A related record was not found."],
  "23514": [422, "constraint_violation", "Some values are not allowed. Check the form and try again."],
};

export async function buildApp(opts: { db: Db; config: Config; logger?: boolean }) {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never log cookies or authorization headers.
    trustProxy: opts.config.NODE_ENV === "production",
  });
  app.decorate("db", opts.db);
  app.decorate("config", opts.config);
  app.decorateRequest("auth", null as unknown as AuthContext);
  await app.register(cookie);

  // CSRF defence in depth (cookies are also SameSite=Lax): state-changing requests must carry a
  // custom header, which browsers will not send cross-site without a CORS preflight.
  app.addHook("onRequest", async (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-pawguild-request"] !== "1") {
      throw new AppError(403, "csrf", "This request was blocked for security reasons. Reload the page and try again.");
    }
  });

  app.decorate("authorize", (permission?: Permission) => async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw unauthenticated();
    const session = await findSession(app.db, token);
    if (!session) throw unauthenticated();
    const membership = await withTenant(
      app.db,
      { orgId: session.organizationId, userId: session.userId },
      (trx) =>
        trx
          .selectFrom("memberships")
          .select(["id", "role", "isActive"])
          .where("organizationId", "=", session.organizationId)
          .where("userId", "=", session.userId)
          .executeTakeFirst(),
    );
    if (!membership || !membership.isActive || !isRole(membership.role)) throw unauthenticated();
    // A temporary password must be replaced before anything else is allowed.
    if (session.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.routeOptions.url ?? "")) {
      throw new AppError(403, "password_change_required", "Please choose a new password before continuing.");
    }
    const permissions = permissionsFor(membership.role);
    req.auth = {
      sessionId: session.sessionId,
      userId: session.userId,
      orgId: session.organizationId,
      membershipId: membership.id,
      role: membership.role,
      permissions,
    };
    if (permission && !permissions.has(permission)) {
      req.log.warn({ userId: session.userId, permission }, "permission denied");
      throw forbidden();
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: "validation_failed",
          message: "Some fields need attention.",
          fields: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      });
    }
    if (err instanceof AppError && err.code === "validation_failed") {
      return reply.status(400).send({ error: { code: err.code, message: err.message, fields: err.details ?? [] } });
    }
    if (err instanceof AppError) {
      return reply
        .status(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pgCode = (err as { code?: string }).code;
    // Business-rule violations raised by our own database triggers carry staff-safe messages.
    if (pgCode === "P0001") {
      const raw = (err as Error).message;
      const msg = raw.charAt(0).toUpperCase() + raw.slice(1);
      return reply.status(409).send({ error: { code: "rule_violation", message: `${msg}.` } });
    }
    const mapped = pgCode ? PG_ERROR_MESSAGES[pgCode] : undefined;
    if (mapped) {
      req.log.info({ pgCode }, "database constraint rejected request");
      return reply.status(mapped[0]).send({ error: { code: mapped[1], message: mapped[2] } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: "The request could not be processed." } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(500).send({
      error: { code: "internal", message: "Something went wrong on our side. Please try again in a moment." },
    });
  });

  app.get("/api/health", async () => ({ ok: true }));
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(customerRoutes, { prefix: "/api/customers" });
  await app.register(employeeRoutes, { prefix: "/api/employees" });
  await app.register(petRoutes, { prefix: "/api/pets" });
  await app.register(medicationRoutes, { prefix: "/api/pets" });
  await app.register(careRoutes, { prefix: "/api" });
  await app.register(incidentRoutes, { prefix: "/api/incidents" });
  await app.register(auditRoutes, { prefix: "/api/audit" });
  await app.register(serviceRoutes, { prefix: "/api/services" });
  await app.register(locationRoutes, { prefix: "/api/locations" });
  await app.register(resourceRoutes, { prefix: "/api/resources" });
  await app.register(reservationRoutes, { prefix: "/api/reservations" });
  await app.register(billingRoutes, { prefix: "/api" });
  await app.register(reportRoutes, { prefix: "/api/reports" });
  await app.register(groomingRoutes, { prefix: "/api/grooming" });
  await app.register(shiftRoutes, { prefix: "/api/shifts" });
  await app.register(dashboardRoutes, { prefix: "/api/dashboard" });
  return app;
}
