import pg from "pg";
import { migrate } from "../src/db/migrate";
import { TEST_APP_ROLE, TEST_OWNER_URL } from "./env";

/** Rebuild the test database schema from migrations before the suite runs. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_OWNER_URL });
  await client.connect();
  const db = (await client.query<{ db: string }>("select current_database() as db")).rows[0]!.db;
  if (!db.endsWith("_test")) throw new Error(`Refusing to reset non-test database "${db}"`);
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();
  await migrate(TEST_OWNER_URL, TEST_APP_ROLE, () => {});
}
