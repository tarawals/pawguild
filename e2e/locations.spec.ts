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

test("owner adds a location with hours and a closure; bookings respect them unless a manager overrides", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("link", { name: "Locations" }).click();
  await expect(page.getByRole("region", { name: "Business hours — Harbor Hounds — Downtown" }).getByLabel("Monday opens")).toHaveValue("07:00");

  await page.getByRole("button", { name: "Add location" }).click();
  const form = page.getByRole("form", { name: "New location" });
  await form.getByLabel("Location name").fill("Harbor Hounds — Uptown");
  await form.getByLabel("City").fill("Portland");
  await form.getByLabel("Country").fill("us");
  await form.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("button", { name: "Harbor Hounds — Uptown" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Details — Harbor Hounds — Uptown" })).toContainText("Portland, US");

  // Weekday hours only, with a mistake caught first.
  const hours = page.getByRole("region", { name: "Business hours — Harbor Hounds — Uptown" });
  await hours.getByLabel("Only allow drop-off and pick-up during business hours").check();
  for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]) await hours.getByLabel(`Open on ${day}`).check();
  await hours.getByLabel("Monday closes").fill("06:00");
  await hours.getByRole("button", { name: "Save hours" }).click();
  await expect(hours.getByText("Closing time must be after opening time")).toBeVisible();
  await hours.getByLabel("Monday closes").fill("18:00");
  await hours.getByRole("button", { name: "Save hours" }).click();
  await expect(hours.getByRole("status")).toContainText("Saved");

  const closures = page.getByRole("region", { name: "Closures — Harbor Hounds — Uptown" });
  await closures.getByLabel("Closed on").fill("2027-02-15");
  await closures.getByLabel("Reason (optional)").fill("Staff training");
  await closures.getByRole("button", { name: "Add closure" }).click();
  await expect(closures.getByRole("list")).toContainText("Feb 15, 2027 — Staff training");

  // Book at Uptown on a Saturday: warned early, refused, then booked with the manager override.
  await page.goto("/customers");
  await page.getByRole("link", { name: "Ellis, Morgan" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Location").selectOption({ label: "Harbor Hounds — Uptown" });
  await page.getByLabel("Biscuit (Golden Retriever)").check();
  await page.getByLabel("Drop-off").fill("2027-02-13T09:00");
  await page.getByLabel("Pick-up").fill("2027-02-13T17:00");
  await expect(page.getByText("Harbor Hounds — Uptown: Mon 7:00 AM–6:00 PM · Tue–Fri 7:00 AM–7:00 PM · Sat–Sun closed · Closed Feb 15, 2027")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Drop-off on Sat, Feb 13 at 9:00 AM: the location is closed on Saturdays" })).toBeVisible();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("ask a manager to book outside business hours");
  await page.getByLabel("Book outside business hours (manager override — recorded in history)").check();
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page).toHaveURL(/\/reservations\/[0-9a-f-]{36}$/);

  // A location with upcoming bookings can't be deactivated; cancel the booking, then it can.
  const reservationUrl = page.url();
  await page.goto("/capacity");
  await page.getByRole("button", { name: "Harbor Hounds — Uptown" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Deactivate location" }).click();
  await expect(page.getByRole("alert")).toContainText("1 upcoming or current reservation");
  await page.goto(reservationUrl);
  await page.getByRole("button", { name: "Cancel reservation" }).click();
  await page.getByLabel("Reason for cancelling").fill("Uptown isn't open yet");
  await page.getByRole("button", { name: "Confirm cancellation" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cancelled");
  await page.goto("/capacity");
  await page.getByRole("button", { name: "Harbor Hounds — Uptown" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Deactivate location" }).click();
  await expect(page.getByRole("button", { name: "Harbor Hounds — Uptown (inactive)" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reactivate location" })).toBeVisible();
});

test("front desk sees hours read-only and can't book on a closed day", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.getByRole("link", { name: "Locations" }).click();
  await expect(page.getByRole("button", { name: "Add location" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Business hours — Harbor Hounds — Downtown" })).toContainText("Mon–Sun 7:00 AM–7:00 PM");
  await expect(page.getByRole("region", { name: "Closures — Harbor Hounds — Downtown" })).toContainText("Christmas Day");

  await page.goto("/customers");
  await page.getByRole("link", { name: "Ellis, Morgan" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Daycare — Full Day — $38.00 per day" });
  await page.getByLabel("Biscuit (Golden Retriever)").check();
  await page.getByLabel("Drop-off").fill("2026-12-25T09:00");
  await page.getByLabel("Pick-up").fill("2026-12-25T17:00");
  await page.getByRole("button", { name: "Create reservation" }).click();
  await expect(page.getByRole("alert")).toContainText("the location is closed that day (Christmas Day)");
  await expect(page.getByLabel(/Book outside business hours/)).toHaveCount(0);
});
