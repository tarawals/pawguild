import { describeHoursProblem, hoursProblem, localParts, type HoursProblem } from "@pawguild/shared";
import type { Tx } from "../db";
import type { AuthContext } from "./auth-context";
import { AppError, forbidden } from "./errors";

export async function locationTimezone(trx: Tx, locationId: string, orgId: string): Promise<string> {
  const row = await trx.selectFrom("locations").innerJoin("organizations as o", "o.id", "locations.organizationId")
    .select(["locations.timezone", "o.timezone as orgTimezone"])
    .where("locations.id", "=", locationId).where("locations.organizationId", "=", orgId).executeTakeFirstOrThrow();
  return row.timezone ?? row.orgTimezone;
}

/**
 * Drop-off and pick-up must fall within the location's business hours and not on a closure date.
 * Only the moments passed in are checked (a reschedule checks only the end that moved).
 * Returns the overridden problems (for the audit log), or throws 409 unless a permitted override was given.
 */
export async function enforceHours(trx: Tx, auth: AuthContext, args: {
  locationId: string; moments: { what: "Drop-off" | "Pick-up"; at: Date }[]; override?: boolean;
}): Promise<string[] | undefined> {
  if (args.moments.length === 0) return undefined;
  const timeZone = await locationTimezone(trx, args.locationId, auth.orgId);
  const dates = args.moments.map((m) => localParts(m.at, timeZone).date);
  const [hours, closures] = await Promise.all([
    trx.selectFrom("locationHours").select(["weekday", "opensAt", "closesAt"]).where("locationId", "=", args.locationId).execute(),
    trx.selectFrom("locationClosures").select(["closedOn", "reason"]).where("locationId", "=", args.locationId).where("closedOn", "in", dates).execute(),
  ]);
  const problems = args.moments
    .map((m) => ({ what: m.what, problem: hoursProblem(m.at, timeZone, hours, closures) }))
    .filter((p): p is { what: "Drop-off" | "Pick-up"; problem: HoursProblem } => p.problem !== null);
  if (problems.length === 0) return undefined;
  const messages = problems.map((p) => describeHoursProblem(p.what, p.problem));
  if (args.override) {
    if (!auth.permissions.has("reservations:override_hours")) throw forbidden();
    return messages;
  }
  throw new AppError(409, "outside_hours",
    `${messages.join(". ")}. Choose times when the location is open, or ask a manager to book outside business hours.`,
    { problems: problems.map((p) => ({ what: p.what, ...p.problem })) });
}
