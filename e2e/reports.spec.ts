import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

const PASSWORD = "pawguild-e2e";
const H = { "x-pawguild-request": "1" };

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
const stat = (page: Page, label: string) => page.locator(".stat").filter({ has: page.getByText(label, { exact: true }) }).locator(".value");

test("the owner's reports match the records, and export to CSV", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  // Make sure today has at least one sale and payment: a custom invoice paid in cash.
  const customer = (await (await page.request.get("/api/customers?q=Ellis")).json()).items[0];
  const location = (await (await page.request.get("/api/locations")).json()).items[0];
  const inv = await (await page.request.post("/api/invoices", { headers: H, data: { customerId: customer.id, locationId: location.id } })).json();
  await page.request.post(`/api/invoices/${inv.id}/lines`, { headers: H, data: { description: "Report check", quantity: 1, unitPriceCents: 1234 } });
  await page.request.post(`/api/invoices/${inv.id}/issue`, { headers: H });
  expect((await page.request.post(`/api/invoices/${inv.id}/payments`, { headers: H, data: { amountCents: 1234, method: "cash" } })).ok()).toBeTruthy();

  await page.getByRole("link", { name: "Reports" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
  await page.getByRole("button", { name: "Today" }).click();
  await expect(page.getByRole("button", { name: "Today" })).toHaveAttribute("aria-pressed", "true");
  const from = await page.getByLabel("From").inputValue();
  const to = await page.getByLabel("To").inputValue();
  expect(from).toBe(to);

  const sales = await (await page.request.get(`/api/reports/sales?from=${from}&to=${to}`)).json();
  expect(sales.totals.invoices).toBeGreaterThan(0);
  await expect(stat(page, "Invoices issued")).toHaveText(String(sales.totals.invoices));
  await expect(stat(page, "Net sales (before tax)")).toHaveText(money(sales.totals.netCents));
  await expect(stat(page, "Sales after credits")).toHaveText(money(sales.totals.salesAfterCreditsCents));
  await expect(page.getByRole("row", { name: /Custom items/ })).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`sales-${from}-to-${to}.csv`);
  const csv = await readFile((await file.path())!, "utf8");
  expect(csv).toContain("Service,Category,Quantity,Gross,Discounts,Net (before tax)");
  expect(csv).toContain(`Sales after credit notes,${(sales.totals.salesAfterCreditsCents / 100).toFixed(2)}`);

  await page.getByRole("button", { name: "Payments" }).click();
  const payments = await (await page.request.get(`/api/reports/payments?from=${from}&to=${to}`)).json();
  await expect(stat(page, "Net collected")).toHaveText(money(payments.totals.netCollectedCents));
  await expect(page.getByRole("row", { name: /^Cash/ })).toBeVisible();

  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByLabel("From")).toHaveCount(0); // balances are "as of now"
  const dashboard = await (await page.request.get("/api/dashboard/summary")).json();
  await expect(stat(page, "Owed by customers")).toHaveText(money(dashboard.outstanding.cents));

  await page.getByRole("button", { name: "Occupancy" }).click();
  await expect(page.getByRole("region", { name: "Harbor Hounds — Downtown" }).first()).toBeVisible();
  await expect(page.getByText("Boarding utilization").first()).toBeVisible();

  // Bad ranges are caught before asking the server.
  await page.getByLabel("From").fill("2030-01-02");
  await expect(page.getByText("The start date must be on or before the end date")).toBeVisible();
});

test("front desk doesn't see reports", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await expect(page.getByRole("link", { name: "Reports" })).toHaveCount(0);
  expect((await page.request.get("/api/reports/balances")).status()).toBe(403);
});
