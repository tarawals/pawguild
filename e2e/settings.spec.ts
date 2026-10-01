import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("owner renames the business and is warned before changing the time zone", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Business settings" }).click();
  const form = page.getByRole("form", { name: "Business details" });
  await expect(form.getByLabel("Time zone")).toHaveValue("America/New_York");
  await expect(form).toContainText("Used by Harbor Hounds — Downtown");

  await form.getByLabel("Business name").fill("Harbor Hounds Resort & Spa");
  await form.getByLabel("Email").fill("not-an-email");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(form.getByText("Enter a valid email address")).toBeVisible();
  await form.getByLabel("Email").fill("hello@harborhounds.example");
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect(form.getByRole("status")).toHaveText("Saved.");
  await expect(page.locator(".topbar")).toContainText("Harbor Hounds Resort & Spa");

  // Changing the time zone asks first; saying no saves nothing.
  await form.getByLabel("Time zone").selectOption("America/Chicago");
  await expect(form.getByText(/changes which day counts as "today"/)).toBeVisible();
  let asked = "";
  page.once("dialog", (d) => { asked = d.message(); void d.dismiss(); });
  await form.getByRole("button", { name: "Save settings" }).click();
  await expect.poll(() => asked).toContain("Existing bookings keep their exact times");
  await page.reload();
  await expect(page.getByRole("form", { name: "Business details" }).getByLabel("Time zone")).toHaveValue("America/New_York");

  // Put the name back for the other tests.
  await page.getByRole("form", { name: "Business details" }).getByLabel("Business name").fill("Harbor Hounds Pet Resort");
  await page.getByRole("form", { name: "Business details" }).getByRole("button", { name: "Save settings" }).click();
  await expect(page.locator(".topbar")).toContainText("Harbor Hounds Pet Resort");
});

test("owner changes how boarding is charged and sees the effect before saving", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto("/settings");
  const rules = page.getByRole("form", { name: "Billing rules" });
  const examples = rules.getByRole("list", { name: "Examples" });
  await expect(examples).toContainText("Boarding, Friday 2 PM to Sunday 11 AM: Boarding — Standard Suite (2 nights) = $110.00");
  await expect(examples).toContainText("Daycare, 8 AM to 12:30 PM: Daycare — Half Day (1 day) = $26.00");

  await rules.getByLabel("Boarding is charged").selectOption("per_24_hours");
  await expect(examples).toContainText("Boarding, Friday 2 PM to Sunday 5 PM (late pick-up): Boarding — Standard Suite (2 24-hour periods) + Daycare — Half Day after the last 24 hours (1 day) = $136.00");
  await rules.getByLabel("Time past the last full 24 hours").selectOption("extra_night");
  await expect(examples).toContainText("(3 24-hour periods) = $165.00");
  await rules.getByLabel("Half day is up to (hours)").fill("3.5"); // 4.5h is over 3.5h + 30 min grace
  await expect(examples).toContainText("Daycare, 8 AM to 12:30 PM: Daycare — Full Day (1 day) = $38.00");
  await rules.getByRole("button", { name: "Save billing rules" }).click();
  await expect(rules.getByRole("status")).toContainText("Saved.");
  await page.reload();
  await expect(page.getByRole("form", { name: "Billing rules" }).getByLabel("Boarding is charged")).toHaveValue("per_24_hours");

  // Back to the defaults for the other tests.
  const again = page.getByRole("form", { name: "Billing rules" });
  await again.getByLabel("Boarding is charged").selectOption("nights");
  await again.getByLabel("Half day is up to (hours)").fill("5");
  await again.getByRole("button", { name: "Save billing rules" }).click();
  await expect(again.getByRole("status")).toContainText("Saved.");
});

test("front desk can see the settings but not change them", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Business settings" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Business details" })).toContainText("America/New York");
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
});
