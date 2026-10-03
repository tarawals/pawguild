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

test("owner adds a half-day membership plan", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Membership plans" });
  await expect(panel.getByRole("row", { name: /Full-Day Club/ })).toContainText("8 full days");
  await panel.getByRole("button", { name: "Add plan" }).click();
  const form = panel.getByRole("form", { name: "New membership plan" });
  await form.getByLabel("Plan name").fill("Half-Day Club");
  await form.getByLabel("Covers").selectOption({ label: "Half days of daycare" });
  await form.getByLabel("Days per month").fill("12");
  await form.getByLabel("Monthly price ($)").fill("240");
  await form.getByRole("button", { name: "Add plan" }).click();
  await expect(panel.getByRole("row", { name: /Half-Day Club/ })).toContainText("$240.00/month");
});

test("front desk signs a customer up, sees this month's days, cancels and keeps it", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  const panel = page.getByRole("region", { name: "Memberships" });
  await panel.getByLabel("Membership plan").selectOption({ label: "Full-Day Club — $280.00/month (8 full days)" });
  await panel.getByRole("button", { name: "Sign up" }).click();
  await expect(panel.getByRole("status")).toContainText("Signed up for Full-Day Club. The first month is billed.");
  const item = panel.getByRole("list", { name: "Customer memberships" });
  await expect(item).toContainText("8 of 8 full days left this month");
  await expect(item).toContainText("Next bill");

  // The first month's invoice is issued for $280.
  await panel.getByRole("link", { name: "Take payment on the invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Unpaid");
  await expect(page.getByRole("region", { name: "Charges" })).toContainText("Full-Day Club membership — 8 full days of daycare");
  await page.goBack();

  await item.getByRole("button", { name: "Cancel membership" }).click();
  await panel.getByLabel("Reason (optional)").fill("Trying it month to month");
  await panel.getByRole("form", { name: "Cancel Full-Day Club" }).getByRole("button", { name: "Cancel membership" }).click();
  await expect(panel.getByRole("status")).toContainText("the last day of the paid month");
  await expect(item).toContainText("Ends");
  await item.getByRole("button", { name: "Keep membership" }).click();
  await expect(panel.getByRole("status")).toContainText("Full-Day Club will continue.");
  await expect(item).toContainText("Next bill");

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Memberships" }).click();
  await expect(page.getByRole("row", { name: /Nguyen, Riley/ })).toContainText("Full-Day Club");
  await expect(page.getByRole("button", { name: "Bill due memberships" })).toBeDisabled(); // nothing due yet
});
