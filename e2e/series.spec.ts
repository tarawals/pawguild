import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("front desk books Mon/Wed/Fri daycare over the holidays, skipping closed days, then cancels the rest", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Nguyen, Riley" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Repeat on a schedule (e.g. every Mon, Wed and Fri)").check();
  const repeatOn = page.getByRole("group", { name: "Repeat on" });
  for (const day of ["Monday", "Wednesday", "Friday"]) await repeatOn.getByLabel(day).check();
  await expect(page.getByLabel("Drop-off time")).toHaveValue("07:30");
  await expect(page.getByLabel("Pick-up time")).toHaveValue("18:00");
  await page.getByLabel("From").fill("2026-12-21");
  await page.getByLabel("Until").fill("2027-01-01");

  await page.getByRole("button", { name: "Check dates" }).click();
  const preview = page.getByRole("region", { name: "4 of 6 dates can be booked" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("Skipped: The location is closed that day (Christmas Day).");
  await expect(preview).toContainText("Skipped: The location is closed that day (New Year's Day).");

  // Changing the pattern means checking again before booking.
  await repeatOn.getByLabel("Friday").uncheck();
  await expect(page.getByRole("button", { name: "Check dates" })).toBeVisible();
  // Back to the pattern that was checked: no need to check again.
  await repeatOn.getByLabel("Friday").check();
  await page.getByRole("button", { name: "Book 4 dates" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toContainText("Juniper · Daycare — Full Day");
  const series = page.getByRole("region", { name: "Repeating booking" });
  await expect(series).toContainText("Every Mon, Wed, Fri, 7:30 AM–6:00 PM, Dec 21, 2026 – Jan 1, 2027. 4 upcoming.");

  await series.getByRole("button", { name: "Cancel this and following" }).click();
  await series.getByRole("button", { name: "Cancel bookings" }).click();
  await expect(series.getByText("Give a reason for cancelling")).toBeVisible();
  await series.getByLabel("Reason for cancelling").fill("Family travelling after all");
  await series.getByRole("button", { name: "Cancel bookings" }).click();
  await expect(series.getByRole("status")).toHaveText("Cancelled 4 bookings from Dec 21, 2026 on.");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cancelled");
  await expect(series).toContainText("0 upcoming.");
});
