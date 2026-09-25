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

test("owner sets the sales tax rate and turns tax on and off per service", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("link", { name: "Locations" }).click();
  await page.getByLabel("Sales tax rate (%)").fill("seven");
  await page.getByRole("button", { name: "Save tax rate" }).click();
  await expect(page.getByText("Enter a percentage like 7 or 8.25")).toBeVisible();
  await page.getByLabel("Sales tax rate (%)").fill("7");
  await page.getByRole("button", { name: "Save tax rate" }).click();
  await expect(page.getByText("Saved. Applies to new and draft invoices.")).toBeVisible();

  await page.getByRole("link", { name: "Services" }).click();
  const daycareTax = page.getByRole("switch", { name: "Sales tax on Daycare — Full Day" });
  await expect(daycareTax).toHaveAttribute("aria-checked", "false");
  await daycareTax.click();
  await expect(daycareTax).toHaveAttribute("aria-checked", "true");
  await daycareTax.click();
  await expect(daycareTax).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Sales tax on Nail Trim" })).toHaveAttribute("aria-checked", "true");
});

test("front desk invoices a stay with a taxable add-on and takes payment", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByLabel("Drop-off").fill("2026-12-01T14:00");
  await page.getByLabel("Pick-up").fill("2026-12-02T11:00");
  await page.getByRole("button", { name: "Create reservation" }).click();

  await page.getByRole("region", { name: "Billing" }).getByRole("button", { name: "Create invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Draft invoice");
  const charges = page.getByRole("region", { name: "Charges" });
  await expect(charges).toContainText("Boarding — Standard Suite — Juniper (1 night)");

  // Nail trim: taxable, 10% off.
  await charges.getByLabel("Service").selectOption({ label: "Nail Trim — $15.00" });
  await charges.getByLabel("Discount type").selectOption("percent");
  await charges.getByLabel("Discount (%)").fill("10");
  await charges.getByRole("button", { name: "Add line" }).click();
  await expect(charges.getByRole("row", { name: /Nail Trim/ })).toContainText("−$1.50");
  await expect(charges.getByRole("row", { name: /Sales tax/ })).toContainText("7% on $13.50");
  await expect(charges.getByRole("row", { name: /Sales tax/ })).toContainText("$0.95"); // 94.5¢ rounds half up
  await expect(charges.getByRole("row", { name: /^Total/ })).toContainText("$69.45");

  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Invoice #0001");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Unpaid");
  await expect(charges.getByRole("button", { name: /Remove/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Void invoice" })).toHaveCount(0); // managers only

  const payments = page.getByRole("region", { name: "Payments" });
  await payments.getByLabel("Amount ($)").fill("100");
  await payments.getByRole("button", { name: "Record payment" }).click();
  await expect(payments.getByText("That's more than the balance due ($69.45). Account credit isn't available yet.")).toBeVisible();
  await payments.getByLabel("Amount ($)").fill("50");
  await payments.getByLabel("Method").selectOption("cash");
  await payments.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Partly paid");
  await expect(charges.getByRole("row", { name: /Balance due/ })).toContainText("$19.45");
  await expect(payments.getByLabel("Amount ($)")).toHaveValue("19.45");
  await payments.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Paid");

  await page.getByRole("link", { name: "Riley Nguyen" }).click();
  await expect(page.getByRole("region", { name: /Billing/ })).toContainText("No balance");
  await expect(page.getByRole("region", { name: /Billing/ })).toContainText("Invoice #0001");
});
