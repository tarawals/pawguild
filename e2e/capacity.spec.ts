import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";
const DAY = "2026-11-02";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

async function startDaycare(page: Page, customer: string) {
  await page.goto("/customers");
  await page.getByRole("link", { name: customer }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Drop-off").fill(`${DAY}T07:30`);
  await page.getByLabel("Pick-up").fill(`${DAY}T18:00`);
}

test.describe.configure({ mode: "serial" });

test("owner sets a daycare limit and books the last space", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("link", { name: "Kennels & capacity" }).click();
  await page.getByLabel("Daycare (pets per day)").fill("1");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await expect(page.getByRole("cell", { name: "Family Suite A", exact: true })).toBeVisible();

  await startDaycare(page, "Nguyen, Riley");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Juniper");
});

test("front desk is told the day is full and cannot override", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await startDaycare(page, "Brooks, Casey");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("Daycare is full for this day: Nov 2 (1/1 booked)");
  await expect(page.getByLabel(/Book over capacity/)).toHaveCount(0);
});

test("owner overrides capacity and assigns a kennel", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await startDaycare(page, "Brooks, Casey");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("Daycare is full");
  await page.getByLabel(/Book over capacity/).check();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Otis");

  const kennels = page.getByRole("region", { name: "Kennels" });
  await kennels.getByLabel("Otis").selectOption({ label: "Kennel 1 · Kennel — free" });
  await kennels.getByRole("button", { name: "Save kennels" }).click();
  await expect(kennels.getByRole("button", { name: "Save kennels" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("region", { name: "Kennels" }).getByLabel("Otis")).toHaveValue(/.+/);
  await expect(page.getByRole("region", { name: "History" })).toContainText("Resources assigned");
});

test("a pet's kennel stays visible after the kennel is taken out of use", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto("/reservations?from=2026-11-02&to=2026-11-02");
  await page.getByRole("row", { name: /Otis/ }).getByRole("link", { name: /Nov 2/ }).click();
  const reservationUrl = page.url();
  const otis = page.getByRole("region", { name: "Kennels" }).getByLabel("Otis");
  await expect(otis).toBeEnabled();
  await expect(otis.locator("option:checked")).toContainText("Kennel 1");

  await page.goto("/capacity");
  await page.getByRole("button", { name: "Edit Kennel 1", exact: true }).click();
  await page.getByLabel("In use").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("row", { name: /^Kennel 1 / })).toContainText("Not in use");

  await page.goto(reservationUrl);
  await expect(otis).toBeEnabled();
  await expect(otis.locator("option:checked")).toHaveText("Kennel 1 (not in use)");
});
