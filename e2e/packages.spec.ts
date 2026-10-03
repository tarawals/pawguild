import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test.describe.configure({ mode: "serial" });

test("owner sets up a half-day package with its own expiry", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Daycare packages" });
  await expect(panel.getByRole("row", { name: /10 Full Days/ })).toContainText("Expires 1 year after purchase");
  await panel.getByRole("button", { name: "Add package" }).click();
  const form = panel.getByRole("form", { name: "New package" });
  await form.getByLabel("Package name").fill("5 Half Days");
  await form.getByLabel("Covers").selectOption({ label: "Half days of daycare" });
  await form.getByLabel("Number of days").fill("5");
  await form.getByLabel("Price ($)").fill("110");
  await form.getByLabel("Expires").selectOption({ label: "Custom…" });
  await form.getByLabel("Expires after (days)").fill("45");
  await form.getByRole("button", { name: "Add package" }).click();
  await expect(panel.getByRole("row", { name: /5 Half Days/ })).toContainText("5 half days");
  await expect(panel.getByRole("row", { name: /5 Half Days/ })).toContainText("Expires 45 days after purchase");
});

test("front desk sells a package and daycare uses it instead of charging", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Brooks, Casey" }).click();
  const packages = page.getByRole("region", { name: "Packages" });
  await packages.getByLabel("Package to sell").selectOption({ label: "10 Full Days — $340.00 (10 full days, expires 1 year after purchase)" });
  await packages.getByRole("button", { name: "Sell" }).click();
  await expect(packages.getByRole("status")).toContainText("Sold 10 Full Days.");
  await expect(packages.getByRole("list", { name: "Customer packages" })).toContainText("10 of 10 full days left");

  // A full day of daycare (default 7:30 AM–6 PM).
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Drop-off").fill("2026-11-16T07:30");
  await page.getByLabel("Pick-up").fill("2026-11-16T18:00");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await page.getByRole("region", { name: "Billing" }).getByRole("button", { name: "Create invoice" }).click();
  const charges = page.getByRole("region", { name: "Charges" });
  await expect(charges).toContainText("Daycare — Full Day — Otis (1 day prepaid: 10 Full Days)");
  await expect(charges.getByRole("row", { name: /^Total/ })).toContainText("$0.00");

  // The package is used automatically, but can be taken off (and put back) while it's a draft.
  const prepaid = charges.getByRole("group", { name: "Prepaid days" });
  await expect(prepaid).toContainText(/Prepaid: 1 day from 10 Full Days — 9 full days left, use by \w{3} \d+, \d{4}\./);
  await prepaid.getByRole("button", { name: "Don't use prepaid days" }).click();
  await expect(prepaid).toContainText(/Prepaid days not used on this invoice\. Available: 10 Full Days \(10 full days left, use by/);
  await expect(charges.getByRole("row", { name: /^Total/ })).toContainText("$38.00");
  await prepaid.getByRole("button", { name: "Use prepaid days" }).click();
  await expect(prepaid).toContainText("Prepaid: 1 day from 10 Full Days — 9 full days left");
  await expect(charges.getByRole("row", { name: /^Total/ })).toContainText("$0.00");

  await page.goto("/customers");
  await page.getByRole("link", { name: "Brooks, Casey" }).click();
  await expect(page.getByRole("region", { name: "Packages" })).toContainText("9 of 10 full days left");
  await expect(page.getByRole("region", { name: "Packages" })).toContainText("Used Nov 16, 2026");
});
