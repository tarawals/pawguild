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
let invoiceUrl = "";

test("front desk takes a deposit, invoices the stay and applies the deposit", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/customers");
  await page.getByRole("link", { name: "Ellis, Morgan" }).click();
  await page.getByRole("link", { name: "New reservation" }).click();
  await page.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await page.getByLabel("Biscuit (Golden Retriever)").check();
  await page.getByLabel("Drop-off").fill("2026-12-10T14:00");
  await page.getByLabel("Pick-up").fill("2026-12-12T11:00");
  await page.getByRole("button", { name: "Create reservation" }).click();

  const billing = page.getByRole("region", { name: "Billing" });
  await billing.getByRole("button", { name: "Take deposit" }).click();
  await billing.getByLabel("Amount ($)").fill("50");
  await billing.getByLabel("Method").selectOption("cash");
  await billing.getByRole("button", { name: "Record deposit" }).click();
  await expect(billing).toContainText("Deposit received: $50.00");

  await billing.getByRole("button", { name: "Create invoice" }).click();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Unpaid");
  invoiceUrl = page.url();

  const payments = page.getByRole("region", { name: "Payments" });
  await expect(payments.getByLabel(/Apply account credit \(\$50\.00 available\)/)).toHaveValue("50.00");
  await payments.getByRole("button", { name: "Apply credit" }).click();
  await expect(page.getByRole("region", { name: "Charges" }).getByRole("row", { name: /Balance due/ })).toContainText("$60.00");
  await expect(payments.getByLabel(/Apply account credit/)).toHaveCount(0); // no credit left
  await payments.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Paid");
  await expect(page.getByRole("button", { name: "Add credit note" })).toHaveCount(0); // managers only
});

test("manager credits a night, refunds part to card and moves the rest to account credit", async ({ page }) => {
  await signIn(page, "owner@harborhounds.example");
  await page.goto(invoiceUrl);
  const adjustments = page.getByRole("region", { name: "Credits and refunds" });
  await adjustments.getByRole("button", { name: "Add credit note" }).click();
  await adjustments.getByLabel("Credit amount ($)").fill("55");
  await adjustments.getByRole("button", { name: "Add credit note" }).click();
  await expect(adjustments.getByText("Give a reason")).toBeVisible();
  await adjustments.getByLabel("Reason").fill("Picked up a night early");
  await adjustments.getByRole("button", { name: "Add credit note" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Overpaid");
  await expect(page.getByRole("region", { name: "Charges" }).getByRole("row", { name: /Owed back/ })).toContainText("$55.00");

  const refund = adjustments.getByRole("form", { name: "Refund overpayment" });
  await refund.getByLabel("Amount ($)").fill("25");
  await refund.getByLabel("Reason").fill("Early pickup");
  await refund.getByRole("button", { name: "Record refund" }).click();
  await expect(refund.getByLabel("Amount ($)")).toHaveValue("30.00");
  await refund.getByLabel("Refund to").selectOption("account_credit");
  await refund.getByLabel("Reason").fill("Keep for next visit");
  await refund.getByRole("button", { name: "Move to account credit" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Paid");
  await expect(adjustments).toContainText("Moved to account credit — Keep for next visit");

  await page.getByRole("link", { name: "Morgan Ellis" }).click();
  const credit = page.getByRole("region", { name: /Account credit/ });
  await expect(credit).toContainText("$30.00");
  await expect(credit).toContainText("Overpayment moved to credit");
  await credit.getByRole("button", { name: "Refund credit" }).click();
  await credit.getByLabel("Refund by").selectOption("cash");
  await credit.getByLabel("Reason").fill("Customer asked for cash back");
  await credit.getByRole("button", { name: "Refund credit" }).click();
  await expect(credit.getByRole("heading")).toContainText("$0.00");
  await expect(credit).toContainText("Refunded to customer");
});
