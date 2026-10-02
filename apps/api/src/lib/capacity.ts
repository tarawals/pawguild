/**
 * Capacity checks. Periods follow packages/shared/src/capacity.ts: daycare per local day,
 * boarding per local night. Only pending, confirmed and checked-in reservations occupy capacity.
 */
import { periodsCovered, type CapacityCategory } from "@pawguild/shared";
import { sql } from "kysely";
import type { Tx } from "../db";

export interface PeriodOccupancy { period: string; booked: number; limit: number | null }

/** Timezone used for a location's calendar (location override, else organization). */
export async function locationTimezone(trx: Tx, locationId: string): Promise<string> {
  const row = await trx.selectFrom("locations as l").innerJoin("organizations as o", "o.id", "l.organizationId")
    .select(["l.timezone as locationTz", "o.timezone as orgTz"]).where("l.id", "=", locationId).executeTakeFirstOrThrow();
  return row.locationTz ?? row.orgTz;
}

/** Pets booked at a location for each period of a category. */
export async function occupancy(trx: Tx, args: {
  locationId: string; category: CapacityCategory; periods: string[]; timeZone: string; excludeReservationId?: string;
  /** Which statuses occupy space. Capacity checks use active stays; reports add completed ones. */
  statuses?: readonly string[];
}): Promise<PeriodOccupancy[]> {
  if (args.periods.length === 0) return [];
  const tz = args.timeZone;
  const startDate = sql`(r.starts_at at time zone ${tz})::date`;
  const endDate = sql`(r.ends_at at time zone ${tz})::date`;
  const covers = args.category === "daycare"
    ? sql`${startDate} <= d.period and ${endDate} >= d.period`
    : sql`${startDate} <= d.period and d.period < greatest(${endDate}, ${startDate} + 1)`;
  const rows = await sql<{ period: string; booked: number }>`
    select d.period::text as period,
      (select count(*) from reservation_pets rp
         join reservations r on r.id = rp.reservation_id
         join services s on s.id = r.service_id
        where r.location_id = ${args.locationId}
          and r.status = any(${args.statuses ?? ["pending", "confirmed", "checked_in"]}::text[])
          and s.category = ${args.category}
          and r.id is distinct from ${args.excludeReservationId ?? null}::uuid
          and ${covers})::int as booked
    from unnest(${args.periods}::date[]) as d(period)
    order by d.period`.execute(trx);
  const limit = await trx.selectFrom("locationCapacities").select("maxPets")
    .where("locationId", "=", args.locationId).where("category", "=", args.category).executeTakeFirst();
  return rows.rows.map((r) => ({ ...r, limit: limit?.maxPets ?? null }));
}

/**
 * Periods that would exceed the location's limit if `petCount` more pets were booked.
 * Locks the location row so concurrent bookings at the same location are serialized.
 */
export async function capacityShortfalls(trx: Tx, args: {
  locationId: string; category: CapacityCategory; startsAt: Date; endsAt: Date; petCount: number; excludeReservationId?: string;
}): Promise<PeriodOccupancy[]> {
  await trx.selectFrom("locations").select("id").where("id", "=", args.locationId).forNoKeyUpdate().executeTakeFirstOrThrow();
  const timeZone = await locationTimezone(trx, args.locationId);
  const periods = periodsCovered(args.category, args.startsAt, args.endsAt, timeZone);
  const rows = await occupancy(trx, { ...args, periods, timeZone });
  return rows.filter((r) => r.limit !== null && r.booked + args.petCount > r.limit);
}
