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

test("a care day: medication order, check-in, logging, voiding a mistake, and an incident", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");

  // Standing medication order on the pet.
  await page.goto("/pets");
  await page.getByRole("link", { name: "Pepper" }).click();
  const meds = page.getByRole("region", { name: "Medications" });
  await meds.getByRole("button", { name: "Add medication" }).click();
  await meds.getByLabel("Medication", { exact: true }).fill("Carprofen");
  await meds.getByLabel("Dose", { exact: true }).fill("25 mg");
  await meds.getByLabel("Times", { exact: true }).fill("breakfast");
  await meds.getByRole("button", { name: "Save medication" }).click();
  await expect(meds.getByText(`"breakfast" isn't a time like 08:00 or 6:30 pm`)).toBeVisible();
  await meds.getByLabel("Times", { exact: true }).fill("");
  await meds.getByRole("button", { name: "Save medication" }).click();
  await expect(meds).toContainText("Carprofen · 25 mg · as needed");

  // Book and check in.
  await page.goto("/customers");
  await page.getByRole("link", { name: "Ellis, Morgan" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByLabel("Pepper (Border Collie)").check();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await page.getByRole("region", { name: "Check-in" }).getByRole("button", { name: "Check in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Checked In");
  const reservationUrl = page.url();

  // Log care from Today's care.
  await page.getByRole("link", { name: "Today's care" }).click();
  const card = page.getByRole("region", { name: "Pepper care" });
  await expect(card.getByText("Chicken")).toBeVisible();          // allergy flag
  await card.getByRole("button", { name: "Fed" }).click();
  await card.getByLabel("Meal").selectOption("dinner");
  await card.getByLabel("Amount eaten").selectOption("some");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByRole("button", { name: "Walk: Pepper" }).click();
  await card.getByRole("button", { name: "Give Carprofen now" }).click();
  await expect(card.getByText(/Medication just now/)).toBeVisible();
  await expect(card.getByText(/Walk just now/)).toBeVisible();

  // Report an incident.
  await card.getByRole("button", { name: "Report incident" }).click();
  await card.getByLabel("What happened").selectOption("altercation");
  await card.getByLabel("Severity").selectOption("medium");
  await card.getByLabel("Description").fill("Nipped by another dog at the gate; no broken skin.");
  await card.getByRole("button", { name: "Submit incident report" }).click();
  await expect(card.getByRole("link", { name: "1 open incident" })).toBeVisible();

  // The stay's care log; void a mistaken walk with a reason.
  await page.goto(reservationUrl);
  const log = page.getByRole("region", { name: "Care log" });
  await expect(log).toContainText("Fed dinner — ate some");
  await expect(log).toContainText("Carprofen 25 mg — Given (as needed)");
  await log.getByRole("button", { name: "Void: Pepper Walk" }).click();
  await log.getByRole("button", { name: "Void entry" }).click();
  await expect(log.getByText("Give a reason")).toBeVisible();
  await log.getByLabel("Why is this entry wrong?").fill("Logged on the wrong dog");
  await log.getByRole("button", { name: "Void entry" }).click();
  await expect(log).toContainText("Voided by Sam Patel: Logged on the wrong dog");
});

test("front desk can follow up an incident but only a manager can resolve it", async ({ page, browser }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Incidents" }).click();
  const incident = page.getByRole("region", { name: /Pepper · Altercation/ });
  await incident.getByRole("button", { name: "Update" }).click();
  await expect(incident.getByLabel(/Resolution/)).toHaveCount(0);
  await incident.getByLabel("Owner has been notified").check();
  await incident.getByRole("button", { name: "Save follow-up" }).click();
  await expect(incident).toContainText("Owner notified");
  await expect(incident.getByText("Not yet")).toHaveCount(0);

  const ownerPage = await (await browser.newContext()).newPage();
  await signIn(ownerPage, "owner@harborhounds.example");
  await expect(ownerPage.getByRole("region", { name: "Open incidents" })).toContainText("Pepper");
  await ownerPage.getByRole("link", { name: "All incidents" }).click();
  const inc = ownerPage.getByRole("region", { name: /Pepper · Altercation/ });
  await inc.getByRole("button", { name: "Update" }).click();
  await inc.getByLabel(/Resolution/).fill("Checked at pickup; owner satisfied.");
  await inc.getByRole("button", { name: "Save and resolve" }).click();
  await expect(ownerPage.getByText("No open incidents")).toBeVisible();
});
