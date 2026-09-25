/** Test database settings. Override with TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL. */
export const TEST_APP_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://pawguild_app:pawguild_app@localhost:5432/pawguild_test";
export const TEST_OWNER_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? "postgres://pawguild:pawguild@localhost:5432/pawguild_test";
export const TEST_APP_ROLE = process.env.TEST_APP_DB_ROLE ?? "pawguild_app";
