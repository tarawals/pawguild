import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}
async function signInHome(page: Page, email: string) {
  await signIn(page, email);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}
async function newPage(browser: Browser) { return (await browser.newContext()).newPage(); }

test.describe.configure({ mode: "serial" });

test("owner adds a staff member, who must choose their own password; deactivation signs them out", async ({ page, browser }) => {
  await signInHome(page, "owner@harborhounds.example");
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Staff" }).click();
  await page.getByRole("button", { name: "Add staff member" }).click();
  const form = page.getByRole("form", { name: "Add staff member" });
  await form.getByLabel("First name").fill("Casey");
  await form.getByLabel("Last name").fill("Lane");
  await form.getByLabel("Email").fill("casey.lane@harborhounds.example");
  await form.getByLabel("Role").selectOption("front_desk");
  await form.getByRole("button", { name: "Add staff member" }).click();
  const creds = page.getByRole("status").filter({ hasText: "Give these to Casey in person" });
  await expect(creds).toBeVisible();
  const temp = (await creds.locator("code").nth(1).textContent())!;
  expect(temp).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  await creds.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row", { name: /Casey Lane/ })).toContainText("Password not set yet");

  // Casey signs in with the temporary password and is made to choose a new one.
  const casey = await newPage(browser);
  await signIn(casey, "casey.lane@harborhounds.example", temp);
  await expect(casey.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  await casey.goto("/customers");
  await expect(casey.getByRole("heading", { name: "Choose your password" })).toBeVisible(); // can't skip it
  await casey.getByLabel("Temporary password").fill(temp);
  await casey.getByLabel("New password", { exact: true }).fill("Caseys-own-pass-1");
  await casey.getByLabel("Confirm new password").fill("Caseys-own-pass-2");
  await casey.getByRole("button", { name: "Set password and continue" }).click();
  await expect(casey.getByText("The new passwords don't match")).toBeVisible();
  await casey.getByLabel("Confirm new password").fill("Caseys-own-pass-1");
  await casey.getByRole("button", { name: "Set password and continue" }).click();
  await expect(casey.getByRole("heading", { level: 1 })).toHaveText("Customers");

  // Owner deactivates Casey: her next action returns her to sign-in, and she can't get back in.
  await page.reload();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Deactivate Casey Lane" }).click();
  await expect(page.getByRole("row", { name: /Casey Lane/ })).toContainText("Deactivated");
  await casey.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pets" }).click();
  await expect(casey).toHaveURL(/\/login\?expired=1/);
  await signIn(casey, "casey.lane@harborhounds.example", "Caseys-own-pass-1");
  await expect(casey.getByRole("alert")).toContainText("isn't active for any business");
});

test("reactivate and reset a password; front desk can see staff but not change them", async ({ page, browser }) => {
  await signInHome(page, "owner@harborhounds.example");
  await page.goto("/staff");
  await page.getByRole("button", { name: "Reactivate Casey Lane" }).click();
  await expect(page.getByRole("row", { name: /Casey Lane/ })).toContainText("Active");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Reset password for Casey Lane" }).click();
  const creds = page.getByRole("status").filter({ hasText: "Give these to Casey in person" });
  const temp = (await creds.locator("code").nth(1).textContent())!;

  const casey = await newPage(browser);
  await signIn(casey, "casey.lane@harborhounds.example", "Caseys-own-pass-1");
  await expect(casey.getByRole("alert")).toContainText("don't match"); // old password no longer works
  await signIn(casey, "casey.lane@harborhounds.example", temp);
  await expect(casey.getByRole("heading", { name: "Choose your password" })).toBeVisible();

  const desk = await newPage(browser);
  await signInHome(desk, "desk@harborhounds.example");
  await desk.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Staff" }).click();
  await expect(desk.getByRole("row", { name: /Jordan Reyes/ })).toContainText("Owner");
  await expect(desk.getByRole("button", { name: "Add staff member" })).toHaveCount(0);
  await expect(desk.getByRole("button", { name: /Deactivate|Reset password|Edit/ })).toHaveCount(0);
});

test("anyone can change their own password from the sidebar", async ({ browser }) => {
  // Uses Casey (from above) so other tests' demo passwords stay unchanged.
  const casey = await newPage(browser);
  const owner = await newPage(browser);
  await signInHome(owner, "owner@harborhounds.example");
  await owner.goto("/staff");
  owner.once("dialog", (d) => d.accept());
  await owner.getByRole("button", { name: "Reset password for Casey Lane" }).click();
  const temp = (await owner.getByRole("status").filter({ hasText: "Give these to Casey" }).locator("code").nth(1).textContent())!;
  await signIn(casey, "casey.lane@harborhounds.example", temp);
  await casey.getByLabel("Temporary password").fill(temp);
  await casey.getByLabel("New password", { exact: true }).fill("First-own-pass-1");
  await casey.getByLabel("Confirm new password").fill("First-own-pass-1");
  await casey.getByRole("button", { name: "Set password and continue" }).click();
  await expect(casey.getByRole("heading", { level: 1 })).toContainText("Good day, Casey");

  await casey.getByRole("link", { name: "Change password" }).click();
  await casey.getByLabel("Current password").fill("wrong-password");
  await casey.getByLabel("New password", { exact: true }).fill("Second-own-pass-2");
  await casey.getByLabel("Confirm new password").fill("Second-own-pass-2");
  await casey.getByRole("button", { name: "Change password" }).click();
  await expect(casey.getByText("That isn't your current password")).toBeVisible();
  await casey.getByLabel("Current password").fill("First-own-pass-1");
  await casey.getByRole("button", { name: "Change password" }).click();
  await expect(casey.getByRole("status")).toContainText("Password changed");
});
