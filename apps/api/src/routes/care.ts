import { careLogInput, voidInput } from "@pawguild/shared";
import type { FastifyPluginAsync } from "fastify";
import { sql } from "kysely";
import { withTenant, type Tx } from "../db";
import { recordAudit } from "../lib/audit";
import { todaysDoses } from "../lib/care";
import { AppError, fieldError, notFound } from "../lib/errors";
import { idParam } from "../lib/params";
import { customerCredit, loadInvoice } from "./billing";
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

  /**
   * Everything the front desk should review before handing a pet back: care over the stay,
   * medication doses not recorded today, open incidents, and the bill.
   */
  app.get("/reservations/:id/checkout-summary", { preHandler: app.authorize("reservations:read") }, async (req) => {
    const id = idParam(req.params, "Reservation");
    return withTenant(app.db, req.auth, async (trx) => {
      const r = await trx.selectFrom("reservations").select(["id", "status", "customerId"]).where("id", "=", id).executeTakeFirst();
      if (!r) throw notFound("Reservation");
      const [pets, logs, doses, incidents] = await Promise.all([
        trx.selectFrom("reservationPets as rp").innerJoin("pets as p", "p.id", "rp.petId").select(["p.id", "p.name"])
          .where("rp.reservationId", "=", id).orderBy("p.name").execute(),
        careLogsFor(trx, id),
        r.status === "checked_in" ? todaysDoses(trx, { reservationIds: [id] }) : Promise.resolve([]),
        trx.selectFrom("incidents").select(["id", "petId", "category", "severity", "ownerNotified", "resolvedAt", "occurredAt"])
          .where("reservationId", "=", id).orderBy("occurredAt").execute(),
      ]);
      const active = logs.filter((l) => !l.voidedAt);
      const petSummaries = pets.map((p) => {
        const mine = active.filter((l) => l.petId === p.id);
        const count = (kind: string) => mine.filter((l) => l.kind === kind).length;
        const feedings = mine.filter((l) => l.kind === "feeding");
        return {
          petId: p.id,
          petName: p.name,
          counts: { feeding: feedings.length, medication: count("medication"), potty: count("potty"), walk: count("walk"), play: count("play"), rest: count("rest") },
          mealsNotFinished: feedings.filter((f) => f.amountEaten === "some" || f.amountEaten === "none").length,
          medicationsGiven: mine.filter((l) => l.kind === "medication").map((l) => ({
            name: l.medicationName, dose: l.dose, status: l.medicationStatus, at: l.occurredAt,
          })),
          notes: mine.filter((l) => l.kind === "note" && l.notes).map((l) => ({ text: l.notes, at: l.occurredAt, by: l.recordedBy })),
          // Doses scheduled today that haven't been recorded (only while checked in).
          dosesNotRecorded: doses.filter((d) => d.petId === p.id && (d.status === "due" || d.status === "overdue"))
            .map((d) => ({ medicationName: d.medicationName, scheduledFor: d.scheduledFor, status: d.status })),
          incidents: incidents.filter((i) => i.petId === p.id),
        };
      });

      let billing = null;
      if (req.auth.permissions.has("billing:read")) {
        const inv = await trx.selectFrom("invoices").select("id").where("reservationId", "=", id).where("status", "<>", "void").executeTakeFirst();
        const loaded = inv ? await loadInvoice(trx, inv.id) : null;
        billing = {
          invoice: loaded && { id: loaded.id, status: loaded.status, number: loaded.number, totalCents: loaded.totals.totalCents,
            balanceCents: loaded.balanceCents, paymentStatus: loaded.paymentStatus, packages: loaded.packages },
          customerCreditCents: await customerCredit(trx, r.customerId),
        };
      }

      const warnings: string[] = [];
      for (const p of petSummaries) {
        if (p.dosesNotRecorded.length) warnings.push(`${p.petName}: ${p.dosesNotRecorded.length} medication dose${p.dosesNotRecorded.length === 1 ? "" : "s"} today not recorded`);
        const open = p.incidents.filter((i) => !i.resolvedAt);
        if (open.some((i) => !i.ownerNotified)) warnings.push(`${p.petName}: incident not yet shared with the owner`);
        else if (open.length) warnings.push(`${p.petName}: ${open.length} open incident${open.length === 1 ? "" : "s"}`);
      }
      if (billing) {
        if (!billing.invoice) warnings.push("No invoice yet");
        else if (billing.invoice.status === "draft") warnings.push("Invoice is still a draft");
        else if (billing.invoice.balanceCents > 0) warnings.push("Invoice not fully paid");
      }
      return { status: r.status, pets: petSummaries, billing, warnings };
    });
  });
};
