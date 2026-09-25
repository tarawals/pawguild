/**
 * Scheduled medication doses for pets currently checked in. Slots are computed in the
 * location's time zone (falling back to the organization's) for the local "today", limited to
 * the part of the day the pet is actually with us.
 */
import { sql } from "kysely";
import type { Tx } from "../db";

export type DoseStatus = "due" | "overdue" | "given" | "refused" | "skipped";

export interface ScheduledDose {
  reservationId: string;
  petId: string;
  petName: string;
  medicationId: string;
  medicationName: string;
  dosage: string;
  scheduledFor: Date;
  status: DoseStatus;
  careLogId: string | null;
}

/** Minutes after the scheduled time before a dose counts as overdue. */
export const OVERDUE_AFTER_MINUTES = 30;

export async function todaysDoses(trx: Tx, opts: { reservationIds?: string[] } = {}): Promise<ScheduledDose[]> {
  if (opts.reservationIds && opts.reservationIds.length === 0) return [];
  const filter = opts.reservationIds ? sql`and r.id = any(${opts.reservationIds}::uuid[])` : sql``;
  const rows = await sql<{
    reservationId: string; petId: string; petName: string; medicationId: string; medicationName: string;
    dosage: string; scheduledFor: Date; logStatus: string | null; careLogId: string | null;
  }>`
    select r.id as reservation_id, p.id as pet_id, p.name as pet_name, m.id as medication_id,
           m.name as medication_name, m.dosage, slot.at as scheduled_for,
           cl.medication_status as log_status, cl.id as care_log_id
      from reservations r
      join locations l on l.id = r.location_id
      join organizations o on o.id = r.organization_id
      join reservation_pets rp on rp.reservation_id = r.id
      join pets p on p.id = rp.pet_id
      join pet_medications m on m.pet_id = p.id and m.discontinued_at is null
      cross join lateral (select coalesce(l.timezone, o.timezone) as tz) z
      cross join lateral unnest(m.times) as t(time_of_day)
      cross join lateral (select (((now() at time zone z.tz)::date + t.time_of_day) at time zone z.tz) as at) slot
      left join care_logs cl on cl.pet_medication_id = m.id and cl.scheduled_for = slot.at and cl.voided_at is null
     where r.status = 'checked_in'
       and slot.at >= least(r.starts_at, coalesce(r.checked_in_at, r.starts_at))
       and slot.at <= r.ends_at
       ${filter}
     order by slot.at, p.name, m.name`.execute(trx);
  const now = Date.now();
  return rows.rows.map(({ logStatus, ...r }) => ({
    ...r,
    status: (logStatus as DoseStatus | null)
      ?? (r.scheduledFor.getTime() + OVERDUE_AFTER_MINUTES * 60_000 < now ? "overdue" : "due"),
  }));
}
