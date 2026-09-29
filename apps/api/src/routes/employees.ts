/**
 * Staff administration. Every change is checked against seniority (canAssignRole /
 * canManageStaffMember) so nobody can grant more access than they have, and the business can't
 * lock itself out (no self-deactivation or self-demotion, and the last owner stays an owner).
 */
import {
  canAssignRole, canManageStaffMember, employeeCreateInput, employeeUpdateInput, isRole, passwordResetInput,
  ROLE_LABELS,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { hashPassword } from "../auth/password";
import { revokeUserSessions } from "../auth/session";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { recordAudit } from "../lib/audit";
import { AppError, fieldError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";

const cannot = (what: string) => new AppError(403, "forbidden", `You can't ${what}. Ask someone more senior.`);

async function loadEmployee(trx: Tx, orgId: string, membershipId: string) {
  const row = await trx.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
    .select(["m.id", "m.userId", "m.role", "m.jobTitle", "m.isActive", "m.createdAt", "u.firstName", "u.lastName", "u.email",
      "u.phone", "u.lastLoginAt", "u.mustChangePassword", "u.isActive as userActive"])
    .select(sql<string[]>`coalesce((select array_agg(ml.location_id) from membership_locations ml where ml.membership_id = m.id), '{}')`.as("locationIds"))
    .where("m.id", "=", membershipId).where("m.organizationId", "=", orgId).executeTakeFirst();
  if (!row) throw notFound("Staff member");
  return row;
}

async function activeOwners(trx: Tx, orgId: string) {
  const r = await trx.selectFrom("memberships").select((eb) => eb.fn.countAll<number>().as("n"))
    .where("organizationId", "=", orgId).where("role", "=", "owner").where("isActive", "=", true).executeTakeFirstOrThrow();
  return Number(r.n);
}

async function setLocations(trx: Tx, auth: AuthContext, membershipId: string, locationIds: string[]) {
  const unique = [...new Set(locationIds)];
  if (unique.length) {
    const found = await trx.selectFrom("locations").select("id").where("id", "in", unique).execute();
    if (found.length !== unique.length) throw fieldError("locationIds", "One or more locations weren't found");
  }
  await trx.deleteFrom("membershipLocations").where("membershipId", "=", membershipId).execute();
  if (unique.length) {
    await trx.insertInto("membershipLocations").values(unique.map((locationId) => ({ organizationId: auth.orgId, membershipId, locationId }))).execute();
  }
}

function guard(auth: AuthContext, target: { role: string; userId: string }) {
  if (!isRole(target.role) || !canManageStaffMember(auth.role, target.role)) throw cannot("change this person's account");
}

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("employees:read") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const ids = await trx.selectFrom("memberships").select("id").where("organizationId", "=", req.auth.orgId).execute();
      const items = await Promise.all(ids.map((m) => loadEmployee(trx, req.auth.orgId, m.id)));
      items.sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
      return {
        items: items.map((e) => ({
          ...e, roleLabel: isRole(e.role) ? ROLE_LABELS[e.role] : e.role,
          canManage: isRole(e.role) && canManageStaffMember(req.auth.role, e.role) && e.userId !== req.auth.userId,
        })),
      };
    }),
  );

  app.post("/", { preHandler: app.authorize("employees:manage") }, async (req, reply) => {
    const input = employeeCreateInput.parse(req.body);
    if (!canAssignRole(req.auth.role, input.role)) throw cannot(`give someone the ${ROLE_LABELS[input.role]} role`);
    if (input.temporaryPassword.toLowerCase() === input.email) throw fieldError("temporaryPassword", "Don't use the email address as the password");
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const existing = await trx.selectFrom("users").select("id").where("email", "=", input.email).executeTakeFirst();
      if (existing) throw fieldError("email", "That email already has a PawGuild account. Use a different email address.");
      const user = await trx.insertInto("users").values({
        email: input.email, firstName: input.firstName, lastName: input.lastName, phone: input.phone,
        passwordHash: await hashPassword(input.temporaryPassword), mustChangePassword: true,
      }).returning("id").executeTakeFirstOrThrow();
      const m = await trx.insertInto("memberships").values({
        organizationId: req.auth.orgId, userId: user.id, role: input.role, jobTitle: input.jobTitle,
      }).returning("id").executeTakeFirstOrThrow();
      await setLocations(trx, req.auth, m.id, input.locationIds);
      await recordAudit(trx, req.auth, { action: "employee.created", entityType: "employee", entityId: m.id,
        changes: { email: input.email, role: input.role, locationIds: input.locationIds } });
      return loadEmployee(trx, req.auth.orgId, m.id);
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { preHandler: app.authorize("employees:manage") }, async (req) => {
    const id = idParam(req.params, "Staff member");
    const input = employeeUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await loadEmployee(trx, req.auth.orgId, id);
      const self = before.userId === req.auth.userId;
      if (!self) guard(req.auth, before);
      if (input.role && input.role !== before.role) {
        if (self) throw cannot("change your own role");
        if (!canAssignRole(req.auth.role, input.role)) throw cannot(`give someone the ${ROLE_LABELS[input.role]} role`);
        if (before.role === "owner" && before.isActive && (await activeOwners(trx, req.auth.orgId)) <= 1) {
          throw new AppError(409, "last_owner", "This is the only owner. Make someone else an owner first.");
        }
      }
      if (self && (input.locationIds !== undefined || input.jobTitle !== undefined)) throw cannot("change your own role, title or locations");
      const userFields = { firstName: input.firstName, lastName: input.lastName, phone: input.phone };
      if (Object.values(userFields).some((v) => v !== undefined)) {
        await trx.updateTable("users").set(Object.fromEntries(Object.entries(userFields).filter(([, v]) => v !== undefined)))
          .where("id", "=", before.userId).execute();
      }
      if (input.role !== undefined || input.jobTitle !== undefined) {
        await trx.updateTable("memberships").set({ ...(input.role && { role: input.role }), ...(input.jobTitle !== undefined && { jobTitle: input.jobTitle }) })
          .where("id", "=", id).execute();
      }
      if (input.locationIds) await setLocations(trx, req.auth, id, input.locationIds);
      const after = await loadEmployee(trx, req.auth.orgId, id);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of ["firstName", "lastName", "phone", "role", "jobTitle"] as const) {
        if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
      }
      if ([...before.locationIds].sort().join() !== [...after.locationIds].sort().join()) changes.locationIds = { from: before.locationIds, to: after.locationIds };
      if (Object.keys(changes).length) await recordAudit(trx, req.auth, { action: "employee.updated", entityType: "employee", entityId: id, changes });
      return after;
    });
  });

  for (const [action, active] of [["deactivate", false], ["reactivate", true]] as const) {
    app.post(`/:id/${action}`, { preHandler: app.authorize("employees:manage") }, async (req) => {
      const id = idParam(req.params, "Staff member");
      return withTenant(app.db, req.auth, async (trx) => {
        const e = await loadEmployee(trx, req.auth.orgId, id);
        if (e.userId === req.auth.userId) throw cannot(`${action} your own account`);
        guard(req.auth, e);
        if (!active && e.role === "owner" && e.isActive && (await activeOwners(trx, req.auth.orgId)) <= 1) {
          throw new AppError(409, "last_owner", "This is the only owner. Make someone else an owner first.");
        }
        if (e.isActive === active) return e;
        await trx.updateTable("memberships").set({ isActive: active }).where("id", "=", id).execute();
        // Deactivated staff are signed out everywhere immediately.
        if (!active) await revokeUserSessions(app.db, e.userId);
        await recordAudit(trx, req.auth, { action: `employee.${action}d`, entityType: "employee", entityId: id });
        return loadEmployee(trx, req.auth.orgId, id);
      });
    });
  }

  /** Set a temporary password; the staff member must change it when they next sign in. */
  app.post("/:id/reset-password", { preHandler: app.authorize("employees:manage") }, async (req) => {
    const id = idParam(req.params, "Staff member");
    const { temporaryPassword } = passwordResetInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const e = await loadEmployee(trx, req.auth.orgId, id);
      if (e.userId === req.auth.userId) throw cannot("reset your own password here (use Change password)");
      guard(req.auth, e);
      if (temporaryPassword.toLowerCase() === e.email) throw fieldError("temporaryPassword", "Don't use the email address as the password");
      await trx.updateTable("users").set({ passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true })
        .where("id", "=", e.userId).execute();
      await revokeUserSessions(app.db, e.userId);
      // Unlock them if they'd been locked out by failed sign-ins.
      await trx.deleteFrom("loginAttempts").where("email", "=", e.email).execute();
      await recordAudit(trx, req.auth, { action: "employee.password_reset", entityType: "employee", entityId: id });
      return loadEmployee(trx, req.auth.orgId, id);
    });
  });
};

