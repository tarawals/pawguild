import type { Tx } from "../db";
import type { AuthContext } from "./auth-context";

type Row = Record<string, unknown>;

/** Field-level diff of before/after rows, ignoring bookkeeping columns. */
export function diff(before: Row, after: Row): Record<string, { from: unknown; to: unknown }> {
  const ignore = new Set(["updatedAt", "createdAt", "organizationId", "id"]);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (ignore.has(key)) continue;
    const a = before[key] instanceof Date ? (before[key] as Date).toISOString() : before[key];
    const b = after[key] instanceof Date ? (after[key] as Date).toISOString() : after[key];
    if (a !== b) out[key] = { from: a ?? null, to: b ?? null };
  }
  return out;
}

export async function recordAudit(
  trx: Tx,
  auth: AuthContext,
  entry: { action: string; entityType: string; entityId: string | null; changes?: unknown },
) {
  await trx
    .insertInto("auditLog")
    .values({
      organizationId: auth.orgId,
      userId: auth.userId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      changes: entry.changes === undefined ? null : JSON.stringify(entry.changes),
    })
    .execute();
}
