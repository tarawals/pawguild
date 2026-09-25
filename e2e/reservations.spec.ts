import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("front desk books a boarding stay, checks the pet in from the dashboard, and checks out", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");

  // Start from the reservations page and pick the customer by pet name.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reservations" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Search by name, phone, email or pet").fill("Biscuit");
  await page.getByRole("button", { name: /Ellis, Morgan/ }).click();

  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByLabel("Biscuit (Golden Retriever)").check();
  await expect(page.getByText("Estimated $55.00")).toBeVisible(); // 1 night × 1 pet (default 2pm → 11am next day)
  await page.getByLabel("Pepper (Border Collie)").check();
  await expect(page.getByText("Estimated $110.00")).toBeVisible();
  await page.getByLabel("Pepper (Border Collie)").uncheck();
  await page.getByRole("button", { name: "Create reservation" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Biscuit · Boarding — Standard Suite");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Confirmed");

  // Double-booking the same pet is refused with a clear message.
  await page.goto("/reservations/new");
  await page.getByLabel("Search by name, phone, email or pet").fill("Biscuit");
  await page.getByRole("button", { name: /Ellis, Morgan/ }).click();
  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByLabel("Biscuit (Golden Retriever)").check();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("Biscuit already has a reservation during this time");

  // Check in from the dashboard.
  await page.getByRole("link", { name: "Dashboard" }).click();
  const arrivals = page.getByRole("region", { name: "Arrivals today" });
  await arrivals.getByRole("button", { name: "Check in Biscuit" }).click();
  await expect(arrivals.getByText("No more arrivals today")).toBeVisible();
  await expect(page.getByRole("region", { name: "Departures today" }).getByRole("link", { name: "Biscuit" })).toHaveCount(0); // leaves tomorrow

  // Check out from the reservation page.
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Reservations" }).click();
  await page.getByRole("link", { name: /–/ }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Checked In");
  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Completed");
});

test("cancelling requires a reason", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Full Groom — $85.00 per visit" });
  await expect(page.getByText("Estimated $85.00")).toBeVisible();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await page.getByRole("button", { name: "Cancel reservation" }).click();
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByText("Give a reason for cancelling")).toBeVisible();
  await page.getByLabel("Reason for cancelling").fill("Owner rescheduling");
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cancelled");
  await expect(page.getByText("Owner rescheduling")).toBeVisible();
});
