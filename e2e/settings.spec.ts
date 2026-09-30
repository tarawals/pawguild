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

test("front desk can see the settings but not change them", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Business settings" })).toHaveCount(0);
  await page.goto("/settings");
  await expect(page.getByRole("region", { name: "Business details" })).toContainText("America/New York");
  await expect(page.getByRole("button", { name: "Save settings" })).toHaveCount(0);
});
