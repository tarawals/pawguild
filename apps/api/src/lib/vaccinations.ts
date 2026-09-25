/**
 * Check-in vaccination verification for reservations. Rules live in
 * packages/shared/src/vaccinations.ts; this module gathers the data.
 */
import { calendarDate, checkVaccinations, vaccinationsOk, type VaccineCheck } from "@pawguild/shared";
import type { Tx } from "../db";

export interface PetVaccinationCheck {
  petId: string;
  petName: string;
  checks: VaccineCheck[];
  ok: boolean;
}

/** Vaccination status for every pet on each reservation, keyed by reservation id. */
export async function reservationVaccinationChecks(trx: Tx, reservationIds: string[]): Promise<Map<string, PetVaccinationCheck[]>> {
  const out = new Map<string, PetVaccinationCheck[]>();
  if (reservationIds.length === 0) return out;

  const rows = await trx.selectFrom("reservationPets as rp")
    .innerJoin("reservations as r", "r.id", "rp.reservationId")
    .innerJoin("pets as p", "p.id", "rp.petId")
    .innerJoin("locations as l", "l.id", "r.locationId")
    .innerJoin("organizations as o", "o.id", "r.organizationId")
    .select(["r.id as reservationId", "r.serviceId", "r.startsAt", "r.endsAt", "p.id as petId", "p.name as petName",
      "p.species", "l.timezone as locationTz", "o.timezone as orgTz"])
    .where("r.id", "in", reservationIds)
    .orderBy("p.name")
    .execute();
  if (rows.length === 0) return out;

  const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
  const petIds = [...new Set(rows.map((r) => r.petId))];
  const [requirements, records] = await Promise.all([
    trx.selectFrom("serviceVaccineRequirements").select(["serviceId", "species", "vaccine"])
      .where("serviceId", "in", serviceIds).orderBy("vaccine").execute(),
    trx.selectFrom("petVaccinations").select(["petId", "vaccine", "expiresOn"])
      .where("petId", "in", petIds).where("voidedAt", "is", null).execute(),
  ]);

  for (const row of rows) {
    const tz = row.locationTz ?? row.orgTz;
    const required = requirements.filter((q) => q.serviceId === row.serviceId && q.species === row.species).map((q) => q.vaccine);
    const checks = checkVaccinations(
      required,
      records.filter((v) => v.petId === row.petId),
      calendarDate(row.startsAt, tz),
      calendarDate(row.endsAt, tz),
    );
    const list = out.get(row.reservationId) ?? [];
    list.push({ petId: row.petId, petName: row.petName, checks, ok: vaccinationsOk(checks) });
    out.set(row.reservationId, list);
  }
  return out;
}

/** "Otis: DHPP (not on file), Rabies (expired)" */
export function describeProblems(pets: PetVaccinationCheck[]): string {
  const labels = { missing: "not on file", expired: "expired", expires_during_stay: "expires during stay", current: "current" };
  return pets.filter((p) => !p.ok)
    .map((p) => `${p.petName}: ${p.checks.filter((c) => c.state !== "current").map((c) => `${c.vaccine} (${labels[c.state]})`).join(", ")}`)
    .join("; ");
}
