/**
 * Minimal forward-only SQL migration runner. Files in apps/api/migrations are applied in name
 * order, each in its own transaction, and recorded in schema_migrations. Applied migrations
 * must never be edited; add a new file instead.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

export async function migrate(connectionString: string, appRole: string, log = console.log): Promise<string[]> {
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error("Invalid app role name");
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const body = (await readFile(path.join(MIGRATIONS_DIR, file), "utf8")).replaceAll("{{app_role}}", appRole);
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    if (applied.length === 0) log("database is up to date");
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { loadConfig } = await import("../config");
  const config = loadConfig();
  migrate(config.MIGRATION_DATABASE_URL, config.APP_DB_ROLE).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
