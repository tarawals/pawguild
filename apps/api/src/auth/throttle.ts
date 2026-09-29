/**
 * Sign-in throttling, stored in the database so limits hold across restarts and multiple servers.
 * Unknown emails are counted exactly like real ones, so a lockout reveals nothing about which
 * emails exist.
 */
import type { Config } from "../config";
import type { Db } from "../db";

export interface ThrottleResult { allowed: boolean; retryAfterSeconds: number }

export async function checkLoginThrottle(db: Db, config: Config, email: string, ip: string): Promise<ThrottleResult> {
  const windowStart = new Date(Date.now() - config.LOGIN_WINDOW_MINUTES * 60_000);
  const lastSuccess = await db.selectFrom("loginAttempts").select("attemptedAt")
    .where("email", "=", email).where("succeeded", "=", true).where("attemptedAt", ">", windowStart)
    .orderBy("attemptedAt", "desc").executeTakeFirst();
  const since = lastSuccess && lastSuccess.attemptedAt > windowStart ? lastSuccess.attemptedAt : windowStart;

  const [byEmail, byIp] = await Promise.all([
    db.selectFrom("loginAttempts").select(["attemptedAt"])
      .where("email", "=", email).where("succeeded", "=", false).where("attemptedAt", ">", since)
      .orderBy("attemptedAt", "asc").execute(),
    db.selectFrom("loginAttempts").select(["attemptedAt"])
      .where("ip", "=", ip).where("succeeded", "=", false).where("attemptedAt", ">", windowStart)
      .orderBy("attemptedAt", "asc").execute(),
  ]);
  // Locked until the oldest counted failure falls out of the window.
  const retryAfter = (rows: { attemptedAt: Date }[], limit: number) =>
    rows.length >= limit
      ? Math.max(1, Math.ceil((rows[rows.length - limit]!.attemptedAt.getTime() + config.LOGIN_WINDOW_MINUTES * 60_000 - Date.now()) / 1000))
      : 0;
  const wait = Math.max(retryAfter(byEmail, config.LOGIN_MAX_FAILURES_PER_EMAIL), retryAfter(byIp, config.LOGIN_MAX_FAILURES_PER_IP));
  return { allowed: wait === 0, retryAfterSeconds: wait };
}

export async function recordLoginAttempt(db: Db, email: string, ip: string, succeeded: boolean) {
  await db.insertInto("loginAttempts").values({ email, ip, succeeded }).execute();
  // Opportunistic pruning keeps the table small without a separate job.
  if (Math.random() < 0.02) {
    await db.deleteFrom("loginAttempts").where("attemptedAt", "<", new Date(Date.now() - 86_400_000)).execute();
  }
}
