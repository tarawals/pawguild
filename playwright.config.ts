import { defineConfig } from "@playwright/test";

/** End-to-end tests run the real API and web app against a dedicated database (pawguild_e2e). */
const OWNER_URL = process.env.E2E_MIGRATION_DATABASE_URL ?? "postgres://pawguild:pawguild@localhost:5432/pawguild_e2e";
const APP_URL = process.env.E2E_DATABASE_URL ?? "postgres://pawguild_app:pawguild_app@localhost:5432/pawguild_e2e";
process.env.E2E_MIGRATION_DATABASE_URL = OWNER_URL;

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5174",
    trace: "retain-on-failure",
    // Optional: point at a preinstalled Chromium instead of Playwright's downloaded build.
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && {
      launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE },
    }),
  },
  webServer: [
    {
      command: "npm run start -w @pawguild/api",
      url: "http://127.0.0.1:3101/api/health",
      env: {
        NODE_ENV: "test", PORT: "3101", HOST: "127.0.0.1", DATABASE_URL: APP_URL,
        MIGRATION_DATABASE_URL: OWNER_URL, APP_DB_ROLE: "pawguild_app", COOKIE_SECURE: "false",
      },
      reuseExistingServer: false,
    },
    {
      command: "npm run dev -w @pawguild/web -- --port 5174 --strictPort --host 127.0.0.1",
      url: "http://127.0.0.1:5174",
      env: { API_PROXY_TARGET: "http://127.0.0.1:3101" },
      reuseExistingServer: false,
    },
  ],
});
