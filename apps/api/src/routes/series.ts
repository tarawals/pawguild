/**
 * Recurring reservations. A series books the same pets, service and times on chosen weekdays
 * between two dates. Each occurrence is an ordinary reservation created by the same code as a
 * single booking, so every check applies (pet double-booking, capacity, business hours and
 * closures, groomer). Dates that fail a check are skipped and reported, not overridden.
 *
 * The preview runs exactly the same creation inside a savepoint and rolls it back, so what it
 * shows is what booking would do (at that moment).
 */
import {
  formatTimeOfDay, hhmm, localParts, MAX_SERIES_OCCURRENCES, reservationSeriesInput, seriesCancelInput, seriesDates, WEEKDAY_LABELS,
  zonedDateTime, type HoursProblem,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import type { z } from "zod";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { recordAudit } from "../lib/audit";
import { AppError, fieldError, notFound } from "../lib/errors";
import { locationTimezone } from "../lib/hours";
import { idParam } from "../lib/params";
import { createReservation } from "./reservations";

type Input = z.output<typeof reservationSeriesInput>;
interface Occurrence { date: string; startsAt: string; endsAt: string; ok: boolean; reason?: string; reservationId?: string }

/** A short reason for skipping a date: the first problem only, without advice about overrides. */
function reasonOf(e: AppError): string {
  const fields = Array.isArray(e.details) ? (e.details as { message: string }[]) : [];
  if (fields[0]) return fields[0].message;
  if (e.code === "outside_hours") {
    const p = (e.details as { problems: HoursProblem[] }).problems[0]!;
    if (p.kind === "closure") return `The location is closed that day${p.reason ? ` (${p.reason})` : ""}.`;
    if (p.kind === "closed_day") return `The location is closed on ${WEEKDAY_LABELS[p.weekday]}s.`;
    return `${p.time < p.opensAt ? "Before opening" : "After closing"} (open ${formatTimeOfDay(p.opensAt)}–${formatTimeOfDay(p.closesAt)}).`;
  }
  // Keep the first sentence ("Daycare is full for this day: …", "Pip already has a reservation …").
  return e.message.split(/(?<=\.)\s+(?=[A-Z])/)[0]!;
}

async function runSeries(trx: Tx, auth: AuthContext, input: Input, mode: "preview" | "create") {
  // Problems with the booking as a whole are reported once, before looking at dates.
  const [customer, location, service] = await Promise.all([
    trx.selectFrom("customers").select(["id", "status", "archivedAt"]).where("id", "=", input.customerId).executeTakeFirst(),
    trx.selectFrom("locations").select(["id", "isActive"]).where("id", "=", input.locationId).executeTakeFirst(),
    trx.selectFrom("services").select(["id", "priceUnit", "category", "isActive"]).where("id", "=", input.serviceId).executeTakeFirst(),
  ]);
  if (!customer || customer.archivedAt) throw fieldError("customerId", "That customer was not found or is archived.");
  if (customer.status === "banned") throw fieldError("customerId", "This customer's account is marked as banned.");
  if (!location || !location.isActive) throw fieldError("locationId", "That location was not found or is inactive.");
  if (!service || !service.isActive) throw fieldError("serviceId", "That service was not found or is no longer offered.");
  if (input.groomerMembershipId && service.category !== "grooming") throw fieldError("groomerMembershipId", "A groomer can only be assigned to a grooming appointment.");
  if (service.priceUnit === "per_night") {
    throw fieldError("serviceId", "Repeating bookings are for same-day services such as daycare or grooming. Book overnight stays one at a time.");
  }
  const tz = await locationTimezone(trx, location.id, auth.orgId);
  const dates = seriesDates(input.firstDate, input.lastDate, input.weekdays);
  if (dates.length === 0) throw fieldError("weekdays", "None of the chosen days fall between those dates.");
  if (dates.length > MAX_SERIES_OCCURRENCES) throw fieldError("lastDate", `That's ${dates.length} dates; a series can have up to ${MAX_SERIES_OCCURRENCES}.`);

  let seriesId: string | undefined;
  if (mode === "create") {
    seriesId = (await trx.insertInto("reservationSeries").values({
      organizationId: auth.orgId, customerId: input.customerId, locationId: location.id, serviceId: service.id,
      weekdays: [...input.weekdays].sort(), startTime: input.startTime, endTime: input.endTime,
      firstDate: input.firstDate, lastDate: input.lastDate, notes: input.notes ?? null, createdByUserId: auth.userId,
    }).returning("id").executeTakeFirstOrThrow()).id;
  }

  const now = Date.now();
  const occurrences: Occurrence[] = [];
  for (const date of dates) {
    const startsAt = zonedDateTime(date, input.startTime, tz), endsAt = zonedDateTime(date, input.endTime, tz);
    const occ: Occurrence = { date, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), ok: false };
    if (startsAt.getTime() < now) { occurrences.push({ ...occ, reason: "That time has already passed." }); continue; }
    await sql`savepoint series_occurrence`.execute(trx);
    try {
      const row = await createReservation(trx, auth, {
        customerId: input.customerId, locationId: location.id, serviceId: service.id, petIds: input.petIds,
        startsAt: occ.startsAt, endsAt: occ.endsAt, notes: input.notes, status: input.status,
        groomerMembershipId: input.groomerMembershipId,
      }, seriesId);
      if (mode === "create") {
        await sql`release savepoint series_occurrence`.execute(trx);
        occurrences.push({ ...occ, ok: true, reservationId: row.id });
      } else {
        await sql`rollback to savepoint series_occurrence`.execute(trx);
        occurrences.push({ ...occ, ok: true });
      }
    } catch (e) {
      await sql`rollback to savepoint series_occurrence`.execute(trx);
      if (!(e instanceof AppError)) throw e;
      occurrences.push({ ...occ, reason: reasonOf(e) });
    }
  }
  return { seriesId, timeZone: tz, occurrences, bookable: occurrences.filter((o) => o.ok).length };
}

export const seriesRoutes: FastifyPluginAsync = async (app) => {
  app.post("/preview", { preHandler: app.authorize("reservations:write") }, async (req) => {
    const input = reservationSeriesInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const { occurrences, bookable, timeZone } = await runSeries(trx, req.auth, input, "preview");
      return { occurrences, bookable, timeZone };
    });
  });

  app.post("/", { preHandler: app.authorize("reservations:write") }, async (req, reply) => {
    const input = reservationSeriesInput.parse(req.body);
    const result = await withTenant(app.db, req.auth, async (trx) => {
      const r = await runSeries(trx, req.auth, input, "create");
      if (r.bookable === 0) {
        throw new AppError(409, "nothing_to_book", "None of the dates can be booked. Check the preview for the reasons.", { occurrences: r.occurrences });
      }
      await recordAudit(trx, req.auth, { action: "reservation_series.created", entityType: "reservation_series", entityId: r.seriesId!,
        changes: { ...input, booked: r.occurrences.filter((o) => o.ok).map((o) => o.date), skipped: r.occurrences.filter((o) => !o.ok).map((o) => ({ date: o.date, reason: o.reason })) } });
      return r;
    });
    return reply.status(201).send(result);
  });

  app.get("/:id", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Series");
    return withTenant(app.db, req.auth, async (trx) => {
      const series = await trx.selectFrom("reservationSeries").selectAll().where("id", "=", id).executeTakeFirst();
      if (!series) throw notFound("Series");
      const occurrences = await trx.selectFrom("reservations").select(["id", "status", "startsAt", "endsAt"])
        .where("seriesId", "=", id).orderBy("startsAt").execute();
      return { ...series, startTime: hhmm(series.startTime), endTime: hhmm(series.endTime), occurrences };
    });
  });

  /** Cancel the occurrences on or after a date that haven't started (pending or confirmed). */
  app.post("/:id/cancel", { preHandler: app.authorize("reservations:write") }, async (req) => {
    const id = idParam(req.params, "Series");
    const { fromDate, reason } = seriesCancelInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const series = await trx.selectFrom("reservationSeries").select(["id", "locationId"]).where("id", "=", id).executeTakeFirst();
      if (!series) throw notFound("Series");
      const tz = await locationTimezone(trx, series.locationId, req.auth.orgId);
      const rows = await trx.selectFrom("reservations").select(["id", "status", "startsAt"])
        .where("seriesId", "=", id).where("status", "in", ["pending", "confirmed"]).forNoKeyUpdate().execute();
      const toCancel = rows.filter((r) => localParts(r.startsAt, tz).date >= fromDate);
      const now = new Date();
      for (const r of toCancel) {
        await trx.updateTable("reservations").set({ status: "cancelled", cancelledAt: now, cancellationReason: reason }).where("id", "=", r.id).execute();
        await recordAudit(trx, req.auth, { action: "reservation.cancelled", entityType: "reservation", entityId: r.id,
          changes: { status: { from: r.status, to: "cancelled" }, reason, seriesId: id, fromDate } });
      }
      return { cancelled: toCancel.length };
    });
  });
};
