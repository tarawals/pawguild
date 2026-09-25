import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db";

export const SESSION_COOKIE = "pawguild_session";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(db: Db, userId: string, orgId: string, ttlHours: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  await db
    .insertInto("sessions")
    .values({ tokenHash: hashToken(token), userId, organizationId: orgId, expiresAt })
    .execute();
  return { token, expiresAt };
}

/** Look up an unexpired, unrevoked session for an active user. */
export async function findSession(db: Db, token: string) {
  return db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.userId")
    .select(["s.id as sessionId", "s.userId", "s.organizationId", "s.expiresAt"])
    .where("s.tokenHash", "=", hashToken(token))
    .where("s.revokedAt", "is", null)
    .where("s.expiresAt", ">", new Date())
    .where("u.isActive", "=", true)
    .executeTakeFirst();
}

export async function revokeSession(db: Db, token: string) {
  await db
    .updateTable("sessions")
    .set({ revokedAt: new Date() })
    .where("tokenHash", "=", hashToken(token))
    .where("revokedAt", "is", null)
    .execute();
}
