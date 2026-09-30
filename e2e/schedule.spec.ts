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

test("front desk sees who's working and the week, but can't change it", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  const working = page.getByRole("region", { name: "Working today" });
  await expect(working).toContainText("Sam Patel");
  await expect(working).toContainText("7:00 AM–3:00 PM");
  await expect(working).toContainText("Avery Lin");
  await working.getByRole("link", { name: "Staff schedule" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Staff schedule");
  await expect(page.getByRole("row", { name: /Sam Patel \(you\)/ })).toContainText("7 AM–3 PM");
  await expect(page.getByRole("row", { name: /Sam Patel/ })).toContainText("56h"); // 7 × 8 hours
  await expect(page.getByRole("button", { name: "Add shift" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Edit / })).toHaveCount(0);
});

test("owner copies a week, adds and edits shifts, and is stopped from double-booking", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Staff schedule" }).click();
  await page.getByRole("button", { name: "Next week" }).click();
  await expect(page.getByRole("row", { name: /Avery Lin/ }).getByRole("button", { name: /^Edit / })).toHaveCount(0);

  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Copy last week" }).click();
  await expect(page.getByRole("status")).toContainText("Copied 21 shifts from last week.");
  await expect(page.getByRole("row", { name: /Avery Lin/ }).getByRole("button", { name: /^Edit / })).toHaveCount(7);

  // An early grooming shift on Monday, before the 7 AM opening: saved, with a note about it.
  await page.getByRole("button", { name: /^Add shift for Jordan Reyes on / }).first().click();
  const form = page.getByRole("form", { name: "Add shift" });
  await form.getByLabel("Starts").fill("06:00");
  await form.getByLabel("Ends").fill("10:00");
  await form.getByLabel("Note (optional)").fill("Early groom");
  await form.getByRole("button", { name: "Add shift" }).click();
  await expect(page.getByRole("status")).toContainText("is before opening");
  const early = page.getByRole("button", { name: /^Edit Jordan Reyes's shift .* 6:00 AM–10:00 AM \(outside business hours\)$/ });
  await expect(early).toBeVisible();

  // A second, overlapping shift for Sam is refused.
  await page.getByRole("button", { name: /^Add shift for Sam Patel on / }).first().click();
  const again = page.getByRole("form", { name: "Add shift" });
  await again.getByLabel("Starts").fill("14:00");
  await again.getByLabel("Ends").fill("18:00");
  await again.getByRole("button", { name: "Add shift" }).click();
  await expect(page.getByRole("alert")).toContainText("Sam Patel is already scheduled 7:00 AM–3:00 PM on");
  await again.getByRole("button", { name: "Cancel" }).click();

  // Edit the early shift to start at opening, then delete it.
  await early.click();
  const edit = page.getByRole("form", { name: "Edit shift" });
  await edit.getByLabel("Starts").fill("07:00");
  await edit.getByRole("button", { name: "Save shift" }).click();
  await expect(page.getByRole("button", { name: /^Edit Jordan Reyes's shift .* 7:00 AM–10:00 AM$/ })).toBeVisible();
  await page.getByRole("button", { name: /^Edit Jordan Reyes's shift/ }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Delete shift" }).click();
  await expect(page.getByRole("status")).toContainText("Shift deleted.");
  await expect(page.getByRole("button", { name: /^Edit Jordan Reyes's shift/ })).toHaveCount(0);
});

test("the grooming schedule shows the groomer's shift", async ({ page }) => {
  await signIn(page, "groomer@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Grooming" }).click();
  await expect(page.getByRole("region", { name: "Avery Lin (you)" })).toContainText("On shift 9:00 AM–5:00 PM");
});
