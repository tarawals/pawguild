import { formatTimeOfDay, localParts } from "@pawguild/shared";
import { sql } from "kysely";
import type { Tx } from "../db";
import { AppError } from "./errors";

/** Statuses that hold a groomer's time. */
const ACTIVE = ["pending", "confirmed", "checked_in"] as const;

/** Active staff who can be assigned to grooming, groomers first. */
export async function groomingStaff(trx: Tx, orgId: string) {
  const rows = await trx.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
    .select(["m.id as membershipId", "m.role", "m.jobTitle", "u.firstName", "u.lastName"])
    .where("m.organizationId", "=", orgId).where("m.isActive", "=", true).where("u.isActive", "=", true)
    .execute();
  return rows
    .map((r) => ({ membershipId: r.membershipId, role: r.role, jobTitle: r.jobTitle, name: `${r.firstName} ${r.lastName}` }))
    .sort((a, b) => Number(b.role === "groomer") - Number(a.role === "groomer") || a.name.localeCompare(b.name));
}

/**
 * The groomer must be an active staff member with no other active grooming appointment overlapping
 * this one. An advisory lock on the groomer serializes concurrent bookings for the same person.
 */
export async function checkGroomer(trx: Tx, args: {
  orgId: string; membershipId: string; startsAt: Date; endsAt: Date; timeZone: string; excludeReservationId?: string;
}) {
  const groomer = await trx.selectFrom("memberships as m").innerJoin("users as u", "u.id", "m.userId")
    .select(["m.id", "m.isActive", "u.isActive as userActive", "u.firstName", "u.lastName"])
    .where("m.id", "=", args.membershipId).where("m.organizationId", "=", args.orgId).executeTakeFirst();
  if (!groomer) throw new AppError(422, "invalid_reservation", "That groomer was not found.");
  if (!groomer.isActive || !groomer.userActive) {
    throw new AppError(422, "invalid_reservation", `${groomer.firstName} ${groomer.lastName} is no longer active and can't be assigned.`);
  }
  await sql`select pg_advisory_xact_lock(hashtextextended(${`groomer:${args.membershipId}`}, 0))`.execute(trx);
  let q = trx.selectFrom("reservations as r")
    .select(["r.id", "r.startsAt", "r.endsAt"])
    .select(sql<string[]>`(select coalesce(array_agg(p.name order by p.name), '{}') from reservation_pets rp
             join pets p on p.id = rp.pet_id where rp.reservation_id = r.id)`.as("petNames"))
    .where("r.groomerMembershipId", "=", args.membershipId)
    .where("r.status", "in", ACTIVE)
    .where("r.startsAt", "<", args.endsAt)
    .where("r.endsAt", ">", args.startsAt)
    .orderBy("r.startsAt");
  if (args.excludeReservationId) q = q.where("r.id", "<>", args.excludeReservationId);
  const clash = await q.executeTakeFirst();
  if (clash) {
    const t = (d: Date) => formatTimeOfDay(localParts(d, args.timeZone).time);
    throw new AppError(409, "groomer_double_booked",
      `${groomer.firstName} ${groomer.lastName} already has a grooming appointment from ${t(clash.startsAt)} to ${t(clash.endsAt)}` +
      `${clash.petNames.length ? ` (${clash.petNames.join(", ")})` : ""}. Choose another time or groomer.`,
      { reservationId: clash.id });
  }
}
