import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("front desk registers a customer and pet and records a vaccination", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");

  // Customer
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Customers" }).click();
  await page.getByRole("link", { name: "New customer" }).click();
  await page.getByLabel("First name").fill("Taylor");
  await page.getByLabel("Last name").fill("Okafor");
  await page.getByLabel("Mobile phone").fill("555-0123");
  await page.getByLabel("Email", { exact: true }).fill("taylor.okafor@example.com");
  await page.getByRole("button", { name: "Create customer" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Taylor Okafor");

  // Pet
  await page.getByRole("link", { name: "Add pet" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Waffles");
  await page.getByLabel("Breed").fill("Corgi");
  await page.getByLabel("Weight (lb)").fill("27.5");
  await page.getByLabel("Allergies").fill("Chicken");
  await page.getByRole("button", { name: "Add pet" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Waffles");
  await expect(page.getByRole("region", { name: "Care alerts" })).toContainText("Chicken");
  await expect(page.getByText("27.5 lb")).toBeVisible();

  // Vaccination expiring soon shows up on the dashboard
  const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  await page.getByLabel("Vaccine").fill("Rabies");
  await page.getByLabel("Expires on").fill(soon);
  await page.getByRole("button", { name: "Record vaccination" }).click();
  await expect(page.getByRole("cell", { name: "Rabies", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Dashboard" }).click();
  await expect(page.getByRole("row", { name: /Waffles.*Rabies/ })).toBeVisible();

  // Search finds the customer by pet name
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Customers" }).click();
  await page.getByLabel("Search customers").fill("waff");
  await expect(page.getByRole("link", { name: "Okafor, Taylor" })).toBeVisible();
});

test("care attendants cannot create customers", async ({ page }) => {
  await signIn(page, "care@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Customers" }).click();
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await expect(page.getByRole("link", { name: "New customer" })).toHaveCount(0);
});
