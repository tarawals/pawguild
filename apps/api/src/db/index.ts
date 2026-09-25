import { CamelCasePlugin, Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./types";

// Return DATE columns as 'YYYY-MM-DD' strings (never shift them through JS Date/timezones)
// and BIGINT as numbers (counts, identities; values stay within Number.MAX_SAFE_INTEGER).
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
    plugins: [new CamelCasePlugin()],
  });
}

export interface TenantContext {
  orgId: string;
  userId: string;
}

/**
 * Run work inside a transaction scoped to one organization. Row-level security policies read
 * app.current_org_id, so every query in `fn` can only see and write that organization's rows.
 * All tenant data access must go through this function.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_org_id', ${ctx.orgId}, true),
                     set_config('app.current_user_id', ${ctx.userId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Transaction with only the user identity set (used during login before an org is chosen). */
export async function withUser<T>(db: Db, userId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.current_user_id', ${userId}, true)`.execute(trx);
    return fn(trx);
  });
}
