import { expect, test, type Page } from "@playwright/test";
import pg from "pg";

const PASSWORD = "pawguild-e2e";
const DB = process.env.E2E_MIGRATION_DATABASE_URL!;

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

const ROLES = [
  { email: "owner@harborhounds.example", name: "Jordan Reyes", role: "Owner", sees: ["Invoices", "Services", "Locations", "Today's care"], hidden: [] },
  { email: "desk@harborhounds.example", name: "Sam Patel", role: "Front Desk", sees: ["Invoices", "Reservations", "Customers"], hidden: [] },
  { email: "care@harborhounds.example", name: "Alex Kim", role: "Care Attendant", sees: ["Today's care", "Customers", "Pets"], hidden: ["Invoices"] },
];

for (const r of ROLES) {
  test(`${r.role} signs in and sees the right menu`, async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await signIn(page, r.email);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Good day, ${r.name.split(" ")[0]}`);
    const footer = page.locator(".sidebar-footer");
    await expect(footer).toContainText(r.name);
    await expect(footer).toContainText(r.role);
    const nav = page.getByRole("navigation", { name: "Main" });
    for (const item of r.sees) await expect(nav.getByRole("link", { name: item, exact: true })).toBeVisible();
    for (const item of r.hidden) await expect(nav.getByRole("link", { name: item, exact: true })).toHaveCount(0);
  });
}

test("wrong password and unknown email show the same helpful message", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  await signIn(page, "desk@harborhounds.example", "not-the-password");
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match. Try again.");
  await signIn(page, "nobody@harborhounds.example", "whatever");
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match. Try again.");
  await expect(page).toHaveURL(/\/login$/);
});

test("email is case-insensitive and Enter submits the form", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill("DESK@HarborHounds.example");
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Password").press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day, Sam");
});

test("a deep link survives sign-in, and the session survives a reload", async ({ page }) => {
  await page.goto("/invoices?status=paid");
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, "owner@harborhounds.example");
  await expect(page).toHaveURL(/\/invoices/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoices");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Invoices");
});

test("signing out really signs out, including the back button", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, "desk@harborhounds.example");
  await page.getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Customers");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/login$/);
  const res = await page.request.get("/api/auth/me");
  expect(res.status()).toBe(401);
});

test("when a session ends mid-use (e.g. staff deactivated), the next action returns to sign-in", async ({ page }) => {
  await page.goto("/login");
  await signIn(page, "care@harborhounds.example");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
  const db = new pg.Client({ connectionString: DB });
  await db.connect();
  await db.query("update sessions set revoked_at = now() where user_id = (select id from users where email = 'care@harborhounds.example') and revoked_at is null");
  await db.end();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Customers" }).click();
  await expect(page).toHaveURL(/\/login\?expired=1&from=%2Fcustomers$/);
  await expect(page.getByRole("status")).toHaveText("Your session ended. Please sign in again to continue.");
  await signIn(page, "care@harborhounds.example");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Customers"); // back where they were
});

test("the post-sign-in redirect only follows paths on this site", async ({ page }) => {
  await page.goto("/login?from=https://evil.example/phish");
  await signIn(page, "desk@harborhounds.example");
  await expect(page).toHaveURL(/127\.0\.0\.1:5174\/$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/); // let sign-out's own navigation finish first
  await page.goto("/login?from=//evil.example");
  await signIn(page, "desk@harborhounds.example");
  await expect(page).toHaveURL(/127\.0\.0\.1:5174\/$/);
});
