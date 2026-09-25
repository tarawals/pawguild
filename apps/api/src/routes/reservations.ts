import {
  assignmentsInput, isCapacityCategory, allowedTransitions, canTransition, estimateReservation, RESERVATION_STATUS_LABELS,
  reservationInput, reservationListQuery, reservationStatusInput, reservationUpdateInput,
  type PriceUnit, type ReservationStatus,
} from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import type { AuthContext } from "../lib/auth-context";
import { diff, recordAudit } from "../lib/audit";
import { AppError, fieldError, forbidden, notFound } from "../lib/errors";
import { capacityShortfalls, type PeriodOccupancy } from "../lib/capacity";
import { idParam } from "../lib/params";
import { describeProblems, reservationVaccinationChecks } from "../lib/vaccinations";

/** Statuses that hold a pet's time slot. */
const ACTIVE_STATUSES = ["pending", "confirmed", "checked_in"] as const;
const EDITABLE_STATUSES: readonly string[] = ["pending", "confirmed"];

const invalid = (message: string) => new AppError(422, "invalid_reservation", message);

async function orgTimezone(trx: Tx, orgId: string) {
  const org = await trx.selectFrom("organizations").select("timezone").where("id", "=", orgId).executeTakeFirstOrThrow();
  return org.timezone;
}

/**
 * Validates and locks the pets being booked, then rejects overlapping active reservations.
 * Locking the pet rows serializes concurrent bookings of the same pet.
 */
async function checkPets(trx: Tx, customerId: string, petIds: string[], startsAt: Date, endsAt: Date, excludeReservationId?: string) {
  const pets = await trx.selectFrom("pets").select(["id", "name", "status", "archivedAt", "customerId"])
    .where("id", "in", petIds).orderBy("id").forUpdate().execute();
  if (pets.length !== petIds.length || pets.some((p) => p.customerId !== customerId)) {
    throw invalid("One or more pets weren't found for this customer.");
  }
  const unavailable = pets.filter((p) => p.archivedAt || p.status !== "active");
  if (unavailable.length > 0) {
    throw invalid(`${unavailable.map((p) => p.name).join(", ")} can't be booked because the pet is not active.`);
  }
  let overlap = trx.selectFrom("reservationPets as rp")
    .innerJoin("reservations as r", "r.id", "rp.reservationId")
    .innerJoin("pets as p", "p.id", "rp.petId")
    .select(["p.name", "r.id"])
    .where("rp.petId", "in", petIds)
    .where("r.status", "in", ACTIVE_STATUSES)
    .where("r.startsAt", "<", endsAt)
    .where("r.endsAt", ">", startsAt);
  if (excludeReservationId) overlap = overlap.where("r.id", "<>", excludeReservationId);
  const clashes = await overlap.execute();
  if (clashes.length > 0) {
    const names = [...new Set(clashes.map((c) => c.name))].join(", ");
    throw new AppError(409, "pet_double_booked",
      `${names} already ${clashes.length === 1 ? "has" : "have"} a reservation during this time. Adjust the dates or edit the existing reservation.`,
      { reservationIds: [...new Set(clashes.map((c) => c.id))] });
  }
  return pets;
}

async function loadReservation(trx: Tx, id: string, timeZone: string) {
  const r = await trx.selectFrom("reservations as r")
    .innerJoin("customers as c", "c.id", "r.customerId")
    .innerJoin("services as s", "s.id", "r.serviceId")
    .innerJoin("locations as l", "l.id", "r.locationId")
    .select([
      "r.id", "r.status", "r.startsAt", "r.endsAt", "r.unitPriceCents", "r.priceUnit", "r.notes",
      "r.confirmedAt", "r.checkedInAt", "r.checkedOutAt", "r.cancelledAt", "r.cancellationReason",
      "r.createdAt", "r.updatedAt", "r.customerId", "r.serviceId", "r.locationId",
      "c.firstName", "c.lastName", "c.phone", "s.name as serviceName", "s.category as serviceCategory",
      "l.name as locationName", "l.timezone as locationTimezone",
    ])
    .where("r.id", "=", id).executeTakeFirst();
  if (!r) throw notFound("Reservation");
  const pets = await trx.selectFrom("reservationPets as rp").innerJoin("pets as p", "p.id", "rp.petId")
    .leftJoin("resources as res", "res.id", "rp.resourceId")
    .select(["p.id", "p.name", "p.species", "p.breed", "p.allergies", "p.medicalNotes", "rp.resourceId", "res.name as resourceName"])
    .where("rp.reservationId", "=", id).orderBy("p.name").execute();
  const vaccinationCheck = (await reservationVaccinationChecks(trx, [id])).get(id) ?? [];
  const invoice = await trx.selectFrom("invoices").select(["id", "status", "number"])
    .where("reservationId", "=", id).where("status", "<>", "void").executeTakeFirst() ?? null;
  const deposits = await trx.selectFrom("accountCredits").select((eb) => eb.fn.sum<number>("amountCents").as("n"))
    .where("reservationId", "=", id).where("kind", "=", "received").executeTakeFirst();
  const { firstName, lastName, phone, serviceName, serviceCategory, locationName, locationTimezone, ...rest } = r;
  const status = r.status as ReservationStatus;
  return {
    ...rest,
    customer: { id: r.customerId, firstName, lastName, phone },
    service: { id: r.serviceId, name: serviceName, category: serviceCategory },
    location: { id: r.locationId, name: locationName },
    pets,
    vaccinationCheck,
    invoice,
    depositsCents: Number(deposits?.n ?? 0),
    allowedTransitions: allowedTransitions(status),
    estimate: estimateReservation({
      unit: r.priceUnit as PriceUnit, unitPriceCents: r.unitPriceCents, startsAt: r.startsAt, endsAt: r.endsAt,
      petCount: Math.max(1, pets.length), timeZone: locationTimezone ?? timeZone,
    }),
  };
}

function requireStatusPermission(auth: AuthContext, to: ReservationStatus) {
  const needed = to === "checked_in" || to === "completed" ? "stays:check_in_out" : "reservations:write";
  if (!auth.permissions.has(needed)) throw forbidden();
}

function formatPeriod(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Enforce location capacity for daycare/boarding services. Returns the periods that were
 * overridden (for the audit log), or throws 409 when full and no permitted override was given.
 */
async function enforceCapacity(trx: Tx, auth: AuthContext, args: {
  locationId: string; serviceCategory: string; startsAt: Date; endsAt: Date; petCount: number;
  override?: boolean; excludeReservationId?: string;
}): Promise<PeriodOccupancy[] | undefined> {
  if (!isCapacityCategory(args.serviceCategory)) return undefined;
  const short = await capacityShortfalls(trx, { ...args, category: args.serviceCategory });
  if (short.length === 0) return undefined;
  if (args.override) {
    if (!auth.permissions.has("reservations:override_capacity")) throw forbidden();
    return short;
  }
  const unit = args.serviceCategory === "boarding" ? "night" : "day";
  const list = short.slice(0, 5).map((p) => `${formatPeriod(p.period)} (${p.booked}/${p.limit} booked)`).join(", ");
  throw new AppError(409, "capacity_full",
    `${args.serviceCategory === "boarding" ? "Boarding" : "Daycare"} is full for ${short.length === 1 ? `this ${unit}` : `${short.length} ${unit}s`}: ${list}${short.length > 5 ? ", …" : ""}. Choose different dates, or ask a manager to book over capacity.`,
    { periods: short });
}

export const reservationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const f = reservationListQuery.parse(req.query);
    return withTenant(app.db, req.auth, async (trx) => {
      let q = trx.selectFrom("reservations as r")
        .innerJoin("customers as c", "c.id", "r.customerId")
        .innerJoin("services as s", "s.id", "r.serviceId")
        .innerJoin("locations as l", "l.id", "r.locationId");
      if (f.from) q = q.where("r.endsAt", ">", new Date(f.from));
      if (f.to) q = q.where("r.startsAt", "<", new Date(f.to));
      if (f.status) q = q.where("r.status", "=", f.status);
      if (f.customerId) q = q.where("r.customerId", "=", f.customerId);
      if (f.locationId) q = q.where("r.locationId", "=", f.locationId);
      if (f.petId) {
        const petId = f.petId;
        q = q.where((eb) => eb.exists(eb.selectFrom("reservationPets as rp").select("rp.petId")
          .whereRef("rp.reservationId", "=", "r.id").where("rp.petId", "=", petId)));
      }
      const [{ total }] = (await q.select((eb) => eb.fn.countAll<number>().as("total")).execute()) as [{ total: number }];
      const items = await q
        .select(["r.id", "r.status", "r.startsAt", "r.endsAt", "r.customerId", "s.name as serviceName",
          "s.category as serviceCategory", "l.name as locationName"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .select(sql<string[]>`(select coalesce(array_agg(p.name order by p.name), '{}') from reservation_pets rp
                 join pets p on p.id = rp.pet_id where rp.reservation_id = r.id)`.as("petNames"))
        .orderBy("r.startsAt").orderBy("r.id")
        .limit(f.limit).offset(f.offset).execute();
      return { items, total };
    });
  });

  app.get("/:id", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    return withTenant(app.db, req.auth, async (trx) => loadReservation(trx, id, await orgTimezone(trx, req.auth.orgId)));
  });

  app.post("/", { preHandler: app.authorize("reservations:write") }, async (req, reply) => {
    const input = reservationInput.parse(req.body);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    const created = await withTenant(app.db, req.auth, async (trx) => {
      const [customer, location, service] = await Promise.all([
        trx.selectFrom("customers").select(["id", "status", "archivedAt"]).where("id", "=", input.customerId).executeTakeFirst(),
        trx.selectFrom("locations").select(["id", "isActive"]).where("id", "=", input.locationId).executeTakeFirst(),
        trx.selectFrom("services").select(["id", "isActive", "priceCents", "priceUnit", "category"]).where("id", "=", input.serviceId).executeTakeFirst(),
      ]);
      if (!customer || customer.archivedAt) throw invalid("That customer was not found or is archived.");
      if (customer.status === "banned") throw invalid("This customer's account is marked as banned. A manager must change the account status before booking.");
      if (!location || !location.isActive) throw invalid("That location was not found or is inactive.");
      if (!service || !service.isActive) throw invalid("That service was not found or is no longer offered.");
      await checkPets(trx, customer.id, input.petIds, startsAt, endsAt);
      const overridden = await enforceCapacity(trx, req.auth, {
        locationId: location.id, serviceCategory: service.category, startsAt, endsAt,
        petCount: input.petIds.length, override: input.overrideCapacity,
      });

      const now = new Date();
      const row = await trx.insertInto("reservations").values({
        organizationId: req.auth.orgId, customerId: customer.id, locationId: location.id, serviceId: service.id,
        status: input.status, startsAt, endsAt, notes: input.notes, unitPriceCents: service.priceCents,
        priceUnit: service.priceUnit, createdByUserId: req.auth.userId,
        confirmedAt: input.status === "confirmed" ? now : null,
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("reservationPets").values(input.petIds.map((petId) => ({
        organizationId: req.auth.orgId, reservationId: row.id, customerId: customer.id, petId,
      }))).execute();
      await recordAudit(trx, req.auth, { action: "reservation.created", entityType: "reservation", entityId: row.id,
        changes: {
          status: input.status, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), petIds: input.petIds,
          ...(overridden && { capacityOverride: overridden }),
        } });
      return loadReservation(trx, row.id, await orgTimezone(trx, req.auth.orgId));
    });
    return reply.status(201).send(created);
  });

  app.patch("/:id", { preHandler: app.authorize("reservations:write") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    const input = reservationUpdateInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const before = await trx.selectFrom("reservations").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      if (!before) throw notFound("Reservation");
      if (!EDITABLE_STATUSES.includes(before.status)) {
        throw new AppError(409, "not_editable", `A reservation that is ${RESERVATION_STATUS_LABELS[before.status as ReservationStatus]} can't be edited.`);
      }
      const startsAt = input.startsAt ? new Date(input.startsAt) : before.startsAt;
      const endsAt = input.endsAt ? new Date(input.endsAt) : before.endsAt;
      if (endsAt <= startsAt) throw fieldError("endsAt", "End must be after the start");
      const currentPets = (await trx.selectFrom("reservationPets").select("petId").where("reservationId", "=", id).execute()).map((p) => p.petId);
      const petIds = input.petIds ?? currentPets;
      await checkPets(trx, before.customerId, petIds, startsAt, endsAt, id);
      const service = await trx.selectFrom("services").select("category").where("id", "=", before.serviceId).executeTakeFirstOrThrow();
      const overridden = await enforceCapacity(trx, req.auth, {
        locationId: before.locationId, serviceCategory: service.category, startsAt, endsAt,
        petCount: petIds.length, override: input.overrideCapacity, excludeReservationId: id,
      });

      const after = await trx.updateTable("reservations")
        .set({ startsAt, endsAt, ...(input.notes !== undefined && { notes: input.notes }) })
        .where("id", "=", id).returningAll().executeTakeFirstOrThrow();
      const changes: Record<string, unknown> = diff(before, after);
      if (input.petIds) {
        const removed = currentPets.filter((p) => !petIds.includes(p));
        const added = petIds.filter((p) => !currentPets.includes(p));
        if (removed.length) await trx.deleteFrom("reservationPets").where("reservationId", "=", id).where("petId", "in", removed).execute();
        if (added.length) {
          await trx.insertInto("reservationPets").values(added.map((petId) => ({
            organizationId: req.auth.orgId, reservationId: id, customerId: before.customerId, petId,
          }))).execute();
        }
        if (removed.length || added.length) changes.pets = { removed, added };
      }
      if (overridden && Object.keys(changes).length > 0) changes.capacityOverride = overridden;
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "reservation.updated", entityType: "reservation", entityId: id, changes });
      }
      return loadReservation(trx, id, await orgTimezone(trx, req.auth.orgId));
    });
  });

  app.post("/:id/status", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    const { status: to, reason, overrideVaccinations, overrideReason } = reservationStatusInput.parse(req.body);
    requireStatusPermission(req.auth, to);
    return withTenant(app.db, req.auth, async (trx) => {
      const current = await trx.selectFrom("reservations").select(["id", "status"]).where("id", "=", id).forUpdate().executeTakeFirst();
      if (!current) throw notFound("Reservation");
      const from = current.status as ReservationStatus;
      if (!canTransition(from, to)) {
        throw new AppError(409, "invalid_transition",
          `A reservation that is ${RESERVATION_STATUS_LABELS[from]} can't be changed to ${RESERVATION_STATUS_LABELS[to]}.`,
          { allowed: allowedTransitions(from) });
      }
      if (to === "cancelled" && !reason) throw fieldError("reason", "Give a reason for cancelling");

      // Check-in verification: every pet must have the service's required vaccinations, valid
      // through the stay. Managers may override with a reason; the override is audited.
      let vaccinationOverride: { reason: string; problems: string } | undefined;
      if (to === "checked_in") {
        const pets = (await reservationVaccinationChecks(trx, [id])).get(id) ?? [];
        if (pets.some((p) => !p.ok)) {
          const problems = describeProblems(pets);
          if (!overrideVaccinations) {
            throw new AppError(409, "vaccinations_required",
              `Required vaccinations aren't current — ${problems}. Record up-to-date vaccinations on the pet's profile, or ask a manager to override.`,
              { pets: pets.filter((p) => !p.ok) });
          }
          if (!req.auth.permissions.has("stays:override_vaccinations")) throw forbidden();
          if (!overrideReason) throw fieldError("overrideReason", "Explain why this pet is being checked in without current vaccinations");
          vaccinationOverride = { reason: overrideReason, problems };
        }
      }
      const now = new Date();
      await trx.updateTable("reservations").set({
        status: to,
        ...(to === "confirmed" && { confirmedAt: now }),
        ...(to === "checked_in" && { checkedInAt: now }),
        ...(to === "completed" && { checkedOutAt: now }),
        ...(to === "cancelled" && { cancelledAt: now, cancellationReason: reason }),
      }).where("id", "=", id).execute();
      await recordAudit(trx, req.auth, { action: `reservation.${to}`, entityType: "reservation", entityId: id,
        changes: { status: { from, to }, ...(reason && { reason }), ...(vaccinationOverride && { vaccinationOverride }) } });
      return loadReservation(trx, id, await orgTimezone(trx, req.auth.orgId));
    });
  });

  /** Assign (or clear) the kennel/room for each pet on a reservation. */
  app.put("/:id/assignments", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    if (!req.auth.permissions.has("reservations:write") && !req.auth.permissions.has("stays:check_in_out")) throw forbidden();
    const { assignments } = assignmentsInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations").select(["id", "status", "locationId", "startsAt", "endsAt"])
        .where("id", "=", id).forUpdate().executeTakeFirst();
      if (!r) throw notFound("Reservation");
      if (!ACTIVE_STATUSES.includes(r.status as (typeof ACTIVE_STATUSES)[number])) {
        throw new AppError(409, "not_editable", `Kennels can't be changed on a ${RESERVATION_STATUS_LABELS[r.status as ReservationStatus]} reservation.`);
      }
      const current = await trx.selectFrom("reservationPets").select(["petId", "resourceId"]).where("reservationId", "=", id).execute();
      const onReservation = new Set(current.map((p) => p.petId));
      if (assignments.some((a) => !onReservation.has(a.petId))) throw invalid("One or more pets aren't on this reservation.");
      const next = new Map(current.map((p) => [p.petId, p.resourceId]));
      for (const a of assignments) next.set(a.petId, a.resourceId);

      const resourceIds = [...new Set([...next.values()].filter((v): v is string => v !== null))];
      if (resourceIds.length > 0) {
        // Lock the resources so two staff members can't fill the last space at once.
        const resources = await trx.selectFrom("resources").select(["id", "name", "capacity", "isActive", "locationId"])
          .where("id", "in", resourceIds).orderBy("id").forUpdate().execute();
        if (resources.length !== resourceIds.length) throw invalid("That kennel or room was not found.");
        for (const res of resources) {
          if (res.locationId !== r.locationId) throw invalid(`${res.name} is at a different location.`);
          const assignedHere = [...next.values()].filter((v) => v === res.id).length;
          const changed = current.filter((p) => p.resourceId === res.id).length !== assignedHere;
          if (!res.isActive && changed) throw invalid(`${res.name} is not in use.`);
          const other = await trx.selectFrom("reservationPets as rp").innerJoin("reservations as x", "x.id", "rp.reservationId")
            .select((eb) => eb.fn.countAll<number>().as("n"))
            .where("rp.resourceId", "=", res.id).where("x.id", "<>", id)
            .where("x.status", "in", ACTIVE_STATUSES).where("x.startsAt", "<", r.endsAt).where("x.endsAt", ">", r.startsAt)
            .executeTakeFirstOrThrow();
          if (Number(other.n) + assignedHere > res.capacity) {
            throw new AppError(409, "resource_full",
              `${res.name} holds ${res.capacity} pet${res.capacity === 1 ? "" : "s"} and is already occupied during this stay. Choose another.`);
          }
        }
      }
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      for (const a of assignments) {
        const before = current.find((p) => p.petId === a.petId)!.resourceId;
        if (before === a.resourceId) continue;
        await trx.updateTable("reservationPets").set({ resourceId: a.resourceId })
          .where("reservationId", "=", id).where("petId", "=", a.petId).execute();
        changes[a.petId] = { from: before, to: a.resourceId };
      }
      if (Object.keys(changes).length > 0) {
        await recordAudit(trx, req.auth, { action: "reservation.resources_assigned", entityType: "reservation", entityId: id, changes });
      }
      const { timezone } = await trx.selectFrom("organizations").select("timezone").where("id", "=", req.auth.orgId).executeTakeFirstOrThrow();
      return loadReservation(trx, id, timezone);
    });
  });
};
