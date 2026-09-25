import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("front desk is stopped at check-in until missing vaccinations are recorded", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");

  // Book Otis (seeded without DHPP) for boarding starting today.
  await page.goto("/customers");
  await page.getByRole("link", { name: "Brooks, Casey" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Otis");

  // The dashboard flags it instead of offering one-click check-in.
  await page.getByRole("link", { name: "Dashboard" }).click();
  const row = page.getByRole("region", { name: "Arrivals today" }).getByRole("row", { name: /Otis/ });
  await expect(row).toContainText("Vaccines needed");
  await expect(row.getByRole("button", { name: /Check in/ })).toHaveCount(0);
  await row.getByRole("link", { name: /Review vaccinations/ }).click();

  // The check-in panel shows exactly what's missing and blocks check-in.
  const panel = page.getByRole("region", { name: "Check-in" });
  await expect(panel.getByRole("row", { name: /DHPP/ })).toContainText("Not on file");
  await expect(panel.getByRole("row", { name: /Rabies/ })).toContainText("Current");
  await expect(panel.getByRole("button", { name: "Check in" })).toBeDisabled();
  await expect(panel).toContainText("A manager can override if needed");
  await expect(page.getByLabel(/manager override/)).toHaveCount(0);

  // Record the vaccination on the pet's profile, come back, and check in.
  await panel.getByRole("link", { name: "Update Otis's vaccinations" }).click();
  await page.getByLabel("Vaccine").fill("DHPP");
  await page.getByLabel("Expires on").fill("2028-01-31");
  await page.getByRole("button", { name: "Record vaccination" }).click();
  await expect(page.getByRole("cell", { name: "DHPP", exact: true })).toBeVisible();
  await page.goBack();
  await expect(panel).toContainText("Vaccinations current");
  await panel.getByRole("button", { name: "Check in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Checked In");
});

test("a manager can check in with expired vaccinations only by giving a reason", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");

  // Juniper's seeded vaccinations expire in about 200 days; book well after that.
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Drop-off").fill("2027-09-01T07:30");
  await page.getByLabel("Pick-up").fill("2027-09-01T18:00");
  await page.getByRole("button", { name: "Create reservation" }).click();

  const panel = page.getByRole("region", { name: "Check-in" });
  await expect(panel.getByRole("row", { name: /Rabies/ })).toContainText("Expired");
  await panel.getByLabel(/manager override/).check();
  await panel.getByRole("button", { name: "Check in with override" }).click();
  await expect(panel.getByText("Explain why this pet is being checked in without current vaccinations")).toBeVisible();
  await panel.getByLabel("Reason for override").fill("Owner showed current certificate on phone");
  await panel.getByRole("button", { name: "Check in with override" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Checked In");
  await expect(page.getByRole("region", { name: "History" })).toContainText("Checked in");
});

test("managers set required vaccinations per service", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("link", { name: "Services" }).click();
  await expect(page.getByRole("row", { name: /Full Groom/ })).toContainText("Dogs: Rabies");
  await page.getByRole("button", { name: "Edit Full Groom" }).click();
  await page.getByLabel("Vaccines required for dogs").fill("Rabies, Bordetella");
  await page.getByRole("button", { name: "Save service" }).click();
  await expect(page.getByRole("row", { name: /Full Groom/ })).toContainText("Dogs: Bordetella, Rabies");
});
