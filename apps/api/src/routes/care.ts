import { careLogInput, voidInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { recordAudit } from "../lib/audit";
import { todaysDoses } from "../lib/care";
import { AppError, fieldError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";
import { listMedications } from "./medications";

const FUTURE_TOLERANCE_MS = 5 * 60_000;

async function careLogsFor(trx: Tx, reservationId: string) {
  return trx.selectFrom("careLogs as c")
    .innerJoin("pets as p", "p.id", "c.petId")
    .innerJoin("users as u", "u.id", "c.recordedByUserId")
    .leftJoin("users as v", "v.id", "c.voidedByUserId")
    .select(["c.id", "c.kind", "c.occurredAt", "c.notes", "c.meal", "c.amountEaten", "c.medicationName", "c.dose",
      "c.medicationStatus", "c.scheduledFor", "c.createdAt", "c.voidedAt", "c.voidReason", "c.petId", "p.name as petName"])
    .select(sql<string>`u.first_name || ' ' || u.last_name`.as("recordedBy"))
    .select(sql<string | null>`v.first_name || ' ' || v.last_name`.as("voidedBy"))
    .where("c.reservationId", "=", reservationId)
    .orderBy("c.occurredAt", "desc").orderBy("c.createdAt", "desc")
    .execute();
}

export const careRoutes: FastifyPluginAsync = async (app) => {
  /** Everything staff need for pets currently in our care. */
  app.get("/care/today", { preHandler: app.authorize("reservations:read") }, async (req) =>
    withTenant(app.db, req.auth, async (trx) => {
      const stays = await trx.selectFrom("reservations as r")
        .innerJoin("customers as c", "c.id", "r.customerId")
        .innerJoin("services as s", "s.id", "r.serviceId")
        .select(["r.id", "r.startsAt", "r.endsAt", "r.checkedInAt", "s.name as serviceName", "c.phone as customerPhone"])
        .select(sql<string>`c.first_name || ' ' || c.last_name`.as("customerName"))
        .where("r.status", "=", "checked_in").orderBy("r.endsAt").execute();
      const ids = stays.map((s) => s.id);
      if (ids.length === 0) return { stays: [] };
      const [pets, doses, lastLogs, incidents] = await Promise.all([
        trx.selectFrom("reservationPets as rp").innerJoin("pets as p", "p.id", "rp.petId")
          .leftJoin("resources as k", "k.id", "rp.resourceId")
          .select(["rp.reservationId", "p.id", "p.name", "p.species", "p.breed", "p.allergies", "p.medicalNotes",
            "p.feedingInstructions", "p.specialInstructions", "p.behaviorNotes", "k.name as kennel"])
          .where("rp.reservationId", "in", ids).orderBy("p.name").execute(),
        todaysDoses(trx, { reservationIds: ids }),
        // Latest non-voided entry of each kind per pet on these stays.
        trx.selectFrom("careLogs").select(["reservationId", "petId", "kind"])
          .select((eb) => eb.fn.max("occurredAt").as("at"))
          .where("reservationId", "in", ids).where("voidedAt", "is", null)
          .groupBy(["reservationId", "petId", "kind"]).execute(),
        trx.selectFrom("incidents").select(["petId"]).select((eb) => eb.fn.countAll<number>().as("n"))
          .where("resolvedAt", "is", null).groupBy("petId").execute(),
      ]);
      const meds = new Map<string, Awaited<ReturnType<typeof listMedications>>>();
      for (const petId of new Set(pets.map((p) => p.id))) meds.set(petId, await listMedications(trx, petId));
      return {
        stays: stays.map((s) => ({
          ...s,
          pets: pets.filter((p) => p.reservationId === s.id).map(({ reservationId: _r, ...p }) => ({
            ...p,
            medications: meds.get(p.id) ?? [],
            doses: doses.filter((d) => d.reservationId === s.id && d.petId === p.id),
            lastCare: Object.fromEntries(lastLogs.filter((l) => l.reservationId === s.id && l.petId === p.id).map((l) => [l.kind, l.at])),
            openIncidents: Number(incidents.find((i) => i.petId === p.id)?.n ?? 0),
          })),
        })),
      };
    }),
  );

  app.get("/reservations/:id/care-logs", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    return withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations").select("id").where("id", "=", id).executeTakeFirst();
      if (!r) throw notFound("Reservation");
      return { items: await careLogsFor(trx, id) };
    });
  });

  app.post("/reservations/:id/care-logs", { preHandler: app.authorize("care:record") }, async (req, reply) => {
    const reservationId = idParam(req.params, "Reservation");
    const input = careLogInput.parse(req.body);
    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    if (occurredAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw fieldError("occurredAt", "That time is in the future");

    const entry = await withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations").select(["id", "status"]).where("id", "=", reservationId).executeTakeFirst();
      if (!r) throw notFound("Reservation");
      if (r.status !== "checked_in") {
        throw new AppError(409, "not_in_care", "Care can only be recorded while the pet is checked in.");
      }
      const onStay = await trx.selectFrom("reservationPets").select("petId")
        .where("reservationId", "=", reservationId).where("petId", "=", input.petId).executeTakeFirst();
      if (!onStay) throw new AppError(422, "invalid_reference", "That pet isn't on this reservation.");

      let medication: Record<string, unknown> = {};
      if (input.kind === "medication") {
        const med = await trx.selectFrom("petMedications").select(["id", "name", "dosage", "discontinuedAt"])
          .where("id", "=", input.medicationId).where("petId", "=", input.petId).executeTakeFirst();
        if (!med) throw new AppError(422, "invalid_reference", "That medication isn't on file for this pet.");
        if (med.discontinuedAt) throw new AppError(422, "medication_discontinued", `${med.name} has been discontinued.`);
        if (input.scheduledFor) {
          // The dose must match one of the medication's scheduled local times.
          const ok = await sql<{ ok: boolean }>`
            select ((${new Date(input.scheduledFor)}::timestamptz at time zone coalesce(l.timezone, o.timezone))::time
                      = any(m.times)) as ok
              from pet_medications m, reservations r
              join locations l on l.id = r.location_id join organizations o on o.id = r.organization_id
             where m.id = ${med.id} and r.id = ${reservationId}`.execute(trx);
          if (!ok.rows[0]?.ok) throw fieldError("scheduledFor", "That isn't one of this medication's scheduled times");
        }
        medication = {
          petMedicationId: med.id, medicationName: med.name, dose: med.dosage, medicationStatus: input.status,
          scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
        };
      }
      const row = await trx.insertInto("careLogs").values({
        organizationId: req.auth.orgId, reservationId, petId: input.petId, kind: input.kind, occurredAt,
        notes: input.notes, recordedByUserId: req.auth.userId,
        ...(input.kind === "feeding" && { meal: input.meal, amountEaten: input.amountEaten }),
        ...medication,
      }).returning(["id"]).executeTakeFirstOrThrow().catch((err: { code?: string }) => {
        if (err.code === "23505") throw new AppError(409, "dose_already_recorded", "This dose has already been recorded. Refresh to see the latest.");
        throw err;
      });
      // Medication entries are audited individually; routine care is its own record.
      if (input.kind === "medication") {
        await recordAudit(trx, req.auth, { action: "care.medication_recorded", entityType: "reservation", entityId: reservationId,
          changes: { careLogId: row.id, petId: input.petId, ...medication } });
      }
      return (await careLogsFor(trx, reservationId)).find((c) => c.id === row.id)!;
    });
    return reply.status(201).send(entry);
  });

  app.post("/care-logs/:id/void", { preHandler: app.authorize("care:record") }, async (req) => {
    const id = idParam(req.params, "Care entry");
    const { reason } = voidInput.parse(req.body);
    return withTenant(app.db, req.auth, async (trx) => {
      const row = await trx.updateTable("careLogs")
        .set({ voidedAt: new Date(), voidedByUserId: req.auth.userId, voidReason: reason })
        .where("id", "=", id).where("voidedAt", "is", null)
        .returning(["reservationId", "kind", "petId"]).executeTakeFirst();
      if (!row) throw new AppError(404, "not_found", "That care entry was not found or has already been voided.");
      await recordAudit(trx, req.auth, { action: "care.entry_voided", entityType: "reservation", entityId: row.reservationId,
        changes: { careLogId: id, kind: row.kind, petId: row.petId, reason } });
      return { ok: true };
    });
  });
};
