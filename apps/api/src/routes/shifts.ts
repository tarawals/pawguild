/**
 * Staff scheduling. Anyone signed in can see the schedule; managers build it. A person can't be
 * on two overlapping shifts (at any location). Shifts outside business hours are allowed (opening
 * and closing duties) but flagged so managers notice mistakes.
 */
import {
  addDays, copyWeekInput, describeHoursProblem, formatTimeOfDay, hoursProblem, localParts, shiftInput, shiftListQuery,
  shiftUpdateInput, zonedDateTime,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { recordAudit } from "../lib/audit";
import { AppError, fieldError, notFound } from "../lib/errors";
import { locationTimezone } from "../lib/hours";
import { idParam } from "../lib/params";

const COLUMNS = ["s.id", "s.locationId", "s.membershipId", "s.startsAt", "s.endsAt", "s.note", "l.name as locationName", "m.role"] as const;

function baseQuery(trx: Tx) {
  return trx.selectFrom("shifts as s")
    .innerJoin("locations as l", "l.id", "s.locationId")
    .innerJoin("memberships as m", "m.id", "s.membershipId")
    .innerJoin("users as u", "u.id", "m.userId")
    .innerJoin("organizations as o", "o.id", "s.organizationId")
    .select([...COLUMNS])
    .select(sql<string>`u.first_name || ' ' || u.last_name`.as("staffName"))
    .select(sql<string>`coalesce(l.timezone, o.timezone)`.as("timeZone"));
}
type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>["execute"]>>[number];

/** Adds the local date and any business-hours warnings to each shift. */
async function decorate(trx: Tx, rows: Row[]) {
  const locationIds = [...new Set(rows.map((r) => r.locationId))];
  const [hours, closures] = locationIds.length === 0 ? [[], []] : await Promise.all([
    trx.selectFrom("locationHours").select(["locationId", "weekday", "opensAt", "closesAt"]).where("locationId", "in", locationIds).execute(),
    trx.selectFrom("locationClosures").select(["locationId", "closedOn", "reason"]).where("locationId", "in", locationIds).execute(),
  ]);
  return rows.map((r) => {
    const h = hours.filter((x) => x.locationId === r.locationId), c = closures.filter((x) => x.locationId === r.locationId);
    const warnings = ([["Start", r.startsAt], ["End", r.endsAt]] as const).flatMap(([what, at]) => {
      const p = hoursProblem(at, r.timeZone, h, c);
      return p ? [describeHoursProblem(what, p)] : [];
    });
    return { ...r, date: localParts(r.startsAt, r.timeZone).date, warnings };
  });
}

async function loadShift(trx: Tx, id: string) {
  const row = await baseQuery(trx).where("s.id", "=", id).executeTakeFirst();
  if (!row) throw notFound("Shift");
  return (await decorate(trx, [row]))[0]!;
}

/** The person must be active staff here and free for the whole shift. */
async function checkShift(trx: Tx, auth: AuthContext, args: {
  locationId: string; membershipId: string; startsAt: Date; endsAt: Date; excludeId?: string;
}) {
  const location = await trx.selectFrom("locations").select(["id", "isActive"]).where("id", "=", args.locationId).executeTakeFirst();
  if (!location) throw fieldError("locationId", "Choose a location");
  if (!location.isActive) throw fieldError("locationId", "That location is inactive");
  const person = await trx.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
    .select(["m.isActive", "u.isActive as userActive", "u.firstName", "u.lastName"])
    .where("m.id", "=", args.membershipId).where("m.organizationId", "=", auth.orgId).executeTakeFirst();
  if (!person) throw fieldError("membershipId", "Choose a staff member");
  if (!person.isActive || !person.userActive) throw fieldError("membershipId", `${person.firstName} ${person.lastName} is no longer active`);
  const ms = args.endsAt.getTime() - args.startsAt.getTime();
  if (ms <= 0) throw fieldError("endsAt", "The shift must end after it starts");
  if (ms > 16 * 3_600_000) throw fieldError("endsAt", "A shift can be at most 16 hours");
  await sql`select pg_advisory_xact_lock(hashtextextended(${`shift:${args.membershipId}`}, 0))`.execute(trx);
  let q = baseQuery(trx).where("s.membershipId", "=", args.membershipId)
    .where("s.startsAt", "<", args.endsAt).where("s.endsAt", ">", args.startsAt);
  if (args.excludeId) q = q.where("s.id", "<>", args.excludeId);
  const clash = await q.executeTakeFirst();
  if (clash) {
    const p = localParts(clash.startsAt, clash.timeZone), e = localParts(clash.endsAt, clash.timeZone);
    const day = new Date(`${p.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    throw new AppError(409, "shift_overlap",
      `${person.firstName} ${person.lastName} is already scheduled ${formatTimeOfDay(p.time)}–${formatTimeOfDay(e.time)} on ${day} at ${clash.locationName}.`,
      { shiftId: clash.id });
  }
}

const auditRow = (r: { locationId: string; membershipId: string; startsAt: Date; endsAt: Date; note: string | null }) => ({
  locationId: r.locationId, membershipId: r.membershipId, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), note: r.note,
});

export const shiftRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize() }, async (req) => {
    const f = shiftListQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      const localDate = sql`(s.starts_at at time zone coalesce(l.timezone, o.timezone))::date`;
      let q = baseQuery(trx).where(localDate, ">=", sql`${f.from}::date`).where(localDate, "<=", sql`${f.to}::date`)
        .orderBy("s.startsAt").orderBy("staffName");
      if (f.locationId) q = q.where("s.locationId", "=", f.locationId);
      if (f.membershipId) q = q.where("s.membershipId", "=", f.membershipId);
      return { items: await decorate(trx, await q.execute()) };
    });
  });

  app.post("/", { preHandler: app.authorize("schedules:manage") }, async (req, reply) => {
    const input = shiftInput.parse(req.body);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const startsAt = new Date(input.startsAt), endsAt = new Date(input.endsAt);
      await checkShift(trx, req.auth, { locationId: input.locationId, membershipId: input.membershipId, startsAt, endsAt });
      const row = await trx.insertInto("shifts").values({
        organizationId: req.auth.orgId, locationId: input.locationId, membershipId: input.membershipId,
        startsAt, endsAt, note: input.note ?? null, createdByUserId: req.auth.userId,
      }).returning(["id", "locationId", "membershipId", "startsAt", "endsAt", "note"]).executeTakeFirstOrThrow();
      await recordAudit(trx, req.auth, { action: "shift.created", entityType: "shift", entityId: row.id, changes: auditRow(row) });
      return loadShift(trx, row.id);
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { preHandler: app.authorize("schedules:manage") }, async (req) => {
    const id = idParam(req.params, "Shift");
    const input = shiftUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("shifts").select(["id", "locationId", "membershipId", "startsAt", "endsAt", "note"])
        .where("id", "=", id).forNoKeyUpdate().executeTakeFirst();
      if (!before) throw notFound("Shift");
      const next = {
        locationId: input.locationId ?? before.locationId,
        membershipId: input.membershipId ?? before.membershipId,
        startsAt: input.startsAt ? new Date(input.startsAt) : before.startsAt,
        endsAt: input.endsAt ? new Date(input.endsAt) : before.endsAt,
        note: input.note !== undefined ? input.note : before.note,
      };
      await checkShift(trx, req.auth, { ...next, excludeId: id });
      const after = await trx.updateTable("shifts").set(next).where("id", "=", id)
        .returning(["locationId", "membershipId", "startsAt", "endsAt", "note"]).executeTakeFirstOrThrow();
      const a = auditRow(before), b = auditRow(after);
      const changes = Object.fromEntries(Object.keys(b).filter((k) => a[k as keyof typeof a] !== b[k as keyof typeof b])
        .map((k) => [k, { from: a[k as keyof typeof a], to: b[k as keyof typeof b] }]));
      if (Object.keys(changes).length > 0) await recordAudit(trx, req.auth, { action: "shift.updated", entityType: "shift", entityId: id, changes });
      return loadShift(trx, id);
    });
  });

  app.delete("/:id", { preHandler: app.authorize("schedules:manage") }, async (req) => {
    const id = idParam(req.params, "Shift");
    return withTenant(app.db, req.auth, async (trx) => {
      const removed = await trx.deleteFrom("shifts").where("id", "=", id)
        .returning(["locationId", "membershipId", "startsAt", "endsAt", "note"]).executeTakeFirst();
      if (!removed) throw notFound("Shift");
      await recordAudit(trx, req.auth, { action: "shift.deleted", entityType: "shift", entityId: id, changes: auditRow(removed) });
      return { ok: true };
    });
  });

  /**
   * Copy a week's shifts at a location to another week, keeping local wall-clock times (so a
   * 7 AM shift stays 7 AM across a DST change). Shifts that would overlap existing ones, or whose
   * staff member is no longer active, are skipped and reported.
   */
  app.post("/copy-week", { preHandler: app.authorize("schedules:manage") }, async (req) => {
    const { locationId, fromWeekStart, toWeekStart } = copyWeekInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const location = await trx.selectFrom("locations").select("id").where("id", "=", locationId).executeTakeFirst();
      if (!location) throw notFound("Location");
      const tz = await locationTimezone(trx, locationId, req.auth.orgId);
      const localDate = sql`(s.starts_at at time zone ${tz})::date`;
      const source = await baseQuery(trx).where("s.locationId", "=", locationId)
        .where(localDate, ">=", sql`${fromWeekStart}::date`).where(localDate, "<=", sql`${addDays(fromWeekStart, 6)}::date`)
        .orderBy("s.startsAt").execute();
      const shiftDays = Math.round((Date.parse(toWeekStart) - Date.parse(fromWeekStart)) / 86_400_000);
      const created: string[] = [];
      const skipped: { staffName: string; date: string; reason: string }[] = [];
      for (const s of source) {
        const start = localParts(s.startsAt, tz), end = localParts(s.endsAt, tz);
        const startsAt = zonedDateTime(addDays(start.date, shiftDays), start.time, tz);
        const endsAt = zonedDateTime(addDays(end.date, shiftDays), end.time, tz);
        try {
          // A savepoint per shift so one skipped shift doesn't undo the others.
          await sql`savepoint copy_shift`.execute(trx);
          await checkShift(trx, req.auth, { locationId, membershipId: s.membershipId, startsAt, endsAt });
          const row = await trx.insertInto("shifts").values({
            organizationId: req.auth.orgId, locationId, membershipId: s.membershipId, startsAt, endsAt, note: s.note, createdByUserId: req.auth.userId,
          }).returning(["id", "locationId", "membershipId", "startsAt", "endsAt", "note"]).executeTakeFirstOrThrow();
          await sql`release savepoint copy_shift`.execute(trx);
          await recordAudit(trx, req.auth, { action: "shift.created", entityType: "shift", entityId: row.id, changes: { ...auditRow(row), copiedFrom: s.id } });
          created.push(row.id);
        } catch (e) {
          await sql`rollback to savepoint copy_shift`.execute(trx);
          if (!(e instanceof AppError)) throw e;
          const fields = Array.isArray(e.details) ? (e.details as { message: string }[]) : [];
          const reason = fields[0]?.message ?? e.message;
          skipped.push({ staffName: s.staffName, date: addDays(start.date, shiftDays), reason });
        }
      }
      return { created: created.length, skipped };
    });
  });
};
