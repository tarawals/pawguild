import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Runs after the feature tests (see playwright.config.ts), so pages are scanned with real data in them.

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

/** Scans a page with axe (WCAG 2.1 A and AA rules) and lists any violations by rule and element. */
async function violations(page: Page) {
  await page.waitForLoadState("networkidle");
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  return result.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const PAGES = [
  "/", "/customers", "/customers/new", "/pets", "/reservations", "/reservations/new", "/services",
  "/capacity", "/care", "/staff", "/reports", "/grooming", "/schedule", "/settings", "/notifications",
  "/memberships", "/account/password", "/incidents", "/invoices",
];

test("the sign-in page has no accessibility violations", async ({ page }) => {
  await page.goto("/login");
  expect(await violations(page)).toEqual([]);
});

test("every main page has no accessibility violations for the owner", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@harborhounds.example");
  const found: string[] = [];
  for (const path of PAGES) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const v of await violations(page)) found.push(`${path} ${v}`);
  }
  expect(found).toEqual([]);
});

test("detail pages have no accessibility violations", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@harborhounds.example");
  const found: string[] = [];
  const visit = async (label: string) => {
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    for (const v of await violations(page)) found.push(`${label} ${v}`);
  };
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  await visit("customer");
  await page.goto("/pets");
  await page.getByRole("table").getByRole("link").first().click();
  await visit("pet");
  // Open the first reservation and invoice by id (the feature tests created them).
  const reservations = await (await page.request.get("/api/reservations")).json();
  await page.goto(`/reservations/${reservations.items[0].id}`);
  await visit("reservation");
  const invoices = await (await page.request.get("/api/invoices")).json();
  await page.goto(`/invoices/${invoices.items[0].id}`);
  await visit("invoice");
  expect(found).toEqual([]);
});

test("settings forms have no accessibility violations when open", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  for (const name of ["Add plan", "Add package"]) {
    await page.getByRole("button", { name, exact: true }).first().click();
  }
  expect(await violations(page)).toEqual([]);
});
