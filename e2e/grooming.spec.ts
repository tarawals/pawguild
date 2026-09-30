import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";
const DAY = "2027-03-09"; // a Tuesday

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

async function newGroom(page: Page, pet: string, groomer: string) {
  await page.goto("/customers");
  await page.getByRole("link", { name: "Ellis, Morgan" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Full Groom — $85.00 per visit" });
  await page.getByLabel(pet).check();
  await page.getByLabel("Drop-off").fill(`${DAY}T10:00`);
  await page.getByLabel("Pick-up").fill(`${DAY}T12:00`);
  await page.getByLabel("Groomer").selectOption({ label: groomer });
}

test.describe.configure({ mode: "serial" });

test("front desk books groomers, is stopped from double-booking, and assigns from the schedule", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await newGroom(page, "Biscuit (Golden Retriever)", "Avery Lin");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByText("Groomer", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("Avery Lin");

  await newGroom(page, "Pepper (Border Collie)", "Avery Lin");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("Avery Lin already has a grooming appointment from 10:00 AM to 12:00 PM (Biscuit)");
  await page.getByLabel("Groomer").selectOption({ label: "Not assigned yet" });
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("link", { name: "assign on the grooming schedule" })).toBeVisible();
  await page.getByRole("link", { name: "assign on the grooming schedule" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Grooming");
  await expect(page.getByLabel("Date")).toHaveValue(DAY);
  await expect(page.getByText("2 appointments · 1 without a groomer")).toBeVisible();
  const unassigned = page.getByRole("region", { name: "Not assigned (1)" });
  await expect(unassigned).toContainText("Pepper (Border Collie)");
  await expect(page.getByRole("region", { name: "Avery Lin" })).toContainText("Biscuit (Golden Retriever)");
  await expect(page.getByRole("region", { name: "Avery Lin" })).toContainText("1 · 2h booked");

  // Avery is busy then, so the owner takes it.
  await unassigned.getByLabel("Groomer for Pepper at 10:00 AM").selectOption({ label: "Avery Lin" });
  await expect(page.getByRole("alert")).toContainText("Avery Lin already has a grooming appointment");
  await unassigned.getByLabel("Groomer for Pepper at 10:00 AM").selectOption({ label: "Jordan Reyes" });
  await expect(page.getByRole("region", { name: "Jordan Reyes" })).toContainText("Pepper (Border Collie)");
  await expect(page.getByRole("region", { name: /Not assigned/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Next day" }).click();
  await expect(page.getByLabel("Date")).toHaveValue("2027-03-10");
  await expect(page.getByRole("region", { name: "Avery Lin" })).toContainText("Nothing booked.");
});

test("a groomer sees their own day; care attendants can look but not assign", async ({ page }) => {
  await signIn(page, "groomer@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Grooming" }).click();
  await page.getByLabel("Date").fill(DAY);
  await expect(page.getByRole("region", { name: "Jordan Reyes" })).toBeVisible(); // that day has loaded
  // The box is driven by the page address, which updates just after the click.
  await page.getByLabel("Only my appointments").click();
  await expect(page.getByLabel("Only my appointments")).toBeChecked();
  await expect(page.getByRole("region", { name: "Avery Lin (you)" })).toContainText("Biscuit");
  await expect(page.getByRole("region", { name: "Jordan Reyes" })).toHaveCount(0);

  await signIn(page, "care@harborhounds.example");
  await page.goto(`/grooming?date=${DAY}`);
  await expect(page.getByRole("region", { name: "Jordan Reyes" })).toContainText("Pepper");
  await expect(page.getByLabel(/Groomer for/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "New appointment" })).toHaveCount(0);
});
