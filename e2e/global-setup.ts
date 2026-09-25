import pg from "pg";
import { migrate } from "../apps/api/src/db/migrate";
import { seed } from "../apps/api/src/db/seed";

export const E2E_PASSWORD = "pawguild-e2e";

export default async function setup() {
  const url = process.env.E2E_MIGRATION_DATABASE_URL!;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const db = (await client.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
  if (!db.endsWith("_e2e")) throw new Error(`Refusing to reset non-e2e database "${db}"`);
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();
  await migrate(url, "pawguild_app", () => {});
  await seed(url, E2E_PASSWORD);
}
