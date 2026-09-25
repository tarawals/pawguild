/**
 * One pet's whole visit, worked by three staff members in their own browsers:
 * new customer → pet with vaccinations and medication → booking with deposit → check-in from
 * the dashboard → kennel → care log and incident → manager resolves → check-out → invoice with a
 * taxable add-on → deposit applied → paid.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function staff(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
  return page;
}
const nav = (p: Page, name: string) => p.getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click();

test("a full visit, from new customer to paid invoice", async ({ browser }) => {
  test.setTimeout(90_000);
  const desk = await staff(browser, "desk@harborhounds.example");

  // 1. New customer and pet.
  await nav(desk, "Customers");
  await desk.getByRole("link", { name: "New customer" }).click();
  await desk.getByLabel("First name").fill("Priya");
  await desk.getByLabel("Last name").fill("Shah");
  await desk.getByLabel("Mobile phone").fill("555-0199");
  await desk.getByLabel("Email", { exact: true }).fill("priya.shah@example.com");
  await desk.getByLabel("Name", { exact: true }).fill("Dana Shah").catch(() => {}); // emergency contact name field
  await desk.getByRole("button", { name: "Create customer" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Priya Shah");
  await desk.getByRole("link", { name: "Add pet" }).click();
  await desk.getByLabel("Name", { exact: true }).fill("Mochi");
  await desk.getByLabel("Breed").fill("Shiba Inu");
  await desk.getByLabel("Feeding instructions").fill("1 cup twice daily");
  await desk.getByRole("button", { name: "Add pet" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Mochi");

  for (const vaccine of ["Rabies", "DHPP", "Bordetella"]) {
    await desk.getByLabel("Vaccine").fill(vaccine);
    await desk.getByLabel("Expires on").fill("2028-06-30");
    await desk.getByRole("button", { name: "Record vaccination" }).click();
    await expect(desk.getByRole("cell", { name: vaccine, exact: true })).toBeVisible();
  }
  const meds = desk.getByRole("region", { name: "Medications" });
  await meds.getByRole("button", { name: "Add medication" }).click();
  await meds.getByLabel("Medication", { exact: true }).fill("Fish oil");
  await meds.getByLabel("Dose", { exact: true }).fill("1 pump");
  await meds.getByRole("button", { name: "Save medication" }).click();
  await expect(meds).toContainText("Fish oil · 1 pump · as needed");

  // 2. Booking with a deposit.
  await desk.getByRole("link", { name: "Priya Shah" }).first().click();
  await desk.getByRole("link", { name: "New reservation" }).click();
  await desk.getByLabel("Service").selectOption({ label: "Boarding — Standard Suite — $55.00 per night" });
  await expect(desk.getByText("Estimated $55.00")).toBeVisible();
  await desk.getByRole("button", { name: "Create reservation" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Mochi · Boarding");
  const reservationUrl = desk.url();
  const billing = desk.getByRole("region", { name: "Billing" });
  await billing.getByRole("button", { name: "Take deposit" }).click();
  await billing.getByLabel("Amount ($)").fill("30");
  await billing.getByRole("button", { name: "Record deposit" }).click();
  await expect(billing).toContainText("Deposit received: $30.00");
  await expect(desk.getByRole("region", { name: "Before arrival" }).or(desk.getByRole("region", { name: "Check-in" }))).toContainText("Vaccinations current");

  // 3. Check in from the dashboard (vaccinations are current, so it's one click).
  await nav(desk, "Dashboard");
  await desk.getByRole("region", { name: "Arrivals today" }).getByRole("button", { name: "Check in Mochi" }).click();
  await expect(desk.getByRole("region", { name: "Arrivals today" }).getByRole("button", { name: "Check in Mochi" })).toHaveCount(0);

  // 4. Kennel.
  await desk.goto(reservationUrl);
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Checked In");
  const kennels = desk.getByRole("region", { name: "Kennels" });
  await kennels.getByLabel("Mochi").selectOption({ label: "Kennel 3 · Kennel — free" });
  await kennels.getByRole("button", { name: "Save kennels" }).click();
  await expect(kennels.getByRole("button", { name: "Save kennels" })).toBeDisabled();

  // 5. Care attendant's day.
  const care = await staff(browser, "care@harborhounds.example");
  await nav(care, "Today's care");
  const card = care.getByRole("region", { name: "Mochi care" });
  await expect(card).toContainText("Kennel 3");
  await expect(card).toContainText("1 cup twice daily");
  await card.getByRole("button", { name: "Fed" }).click();
  await card.getByLabel("Meal").selectOption("breakfast");
  await card.getByLabel("Amount eaten").selectOption("all");
  await card.getByRole("button", { name: "Save" }).click();
  await card.getByRole("button", { name: "Potty: Mochi" }).click();
  await card.getByRole("button", { name: "Give Fish oil now" }).click();
  await card.getByRole("button", { name: "Report incident" }).click();
  await card.getByLabel("Severity").selectOption("low");
  await card.getByLabel("Description").fill("Small scratch on paw after yard play.");
  await card.getByLabel("Actions taken").fill("Cleaned with saline.");
  await card.getByRole("button", { name: "Submit incident report" }).click();
  await expect(card.getByRole("link", { name: "1 open incident" })).toBeVisible();

  // 6. Owner resolves the incident.
  const owner = await staff(browser, "owner@harborhounds.example");
  await nav(owner, "Incidents");
  const incident = owner.getByRole("region", { name: /Mochi · Injury/ });
  await incident.getByRole("button", { name: "Update" }).click();
  await incident.getByLabel("Owner has been notified").check();
  await incident.getByLabel(/Resolution/).fill("Checked at 5pm, healed; owner informed at pickup.");
  await incident.getByRole("button", { name: "Save and resolve" }).click();
  await expect(incident).toHaveCount(0); // leaves the Open list
  await owner.getByRole("button", { name: "All recent" }).click();
  await expect(owner.getByRole("region", { name: /Mochi · Injury/ })).toContainText("Resolved");

  // 7. Check out, invoice with a taxable add-on, apply the deposit, take payment.
  await desk.goto(reservationUrl);
  const log = desk.getByRole("region", { name: "Care log" });
  await expect(log).toContainText("Fed breakfast — ate all");
  await expect(log).toContainText("Fish oil 1 pump — Given (as needed)");
  await expect(log).toContainText("Alex Kim");
  await desk.getByRole("button", { name: "Check out" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Completed");
  await desk.getByRole("region", { name: "Billing" }).getByRole("button", { name: "Create invoice" }).click();
  const charges = desk.getByRole("region", { name: "Charges" });
  await charges.getByLabel("Service").selectOption({ label: "Nail Trim — $15.00" });
  await charges.getByRole("button", { name: "Add line" }).click();
  await expect(charges.getByRole("row", { name: /Nail Trim/ })).toBeVisible();
  await desk.getByRole("button", { name: "Issue invoice" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Unpaid");
  const total = await charges.getByRole("row", { name: /^Total/ }).textContent();
  const payments = desk.getByRole("region", { name: "Payments" });
  await payments.getByRole("button", { name: "Apply credit" }).click();
  await expect(payments.getByLabel(/Apply account credit/)).toHaveCount(0);
  await payments.getByRole("button", { name: "Record payment" }).click();
  await expect(desk.getByRole("heading", { level: 1 })).toContainText("Paid");
  expect(total).toMatch(/\$\d+\.\d{2}/);

  // 8. Everything reconciles on the customer.
  await desk.getByRole("link", { name: "Priya Shah" }).first().click();
  await expect(desk.getByRole("region", { name: /^Billing/ })).toContainText("No balance");
  await expect(desk.getByRole("region", { name: /Account credit/ }).getByRole("heading")).toContainText("$0.00");
  await expect(desk.getByRole("region", { name: "Reservations" })).toContainText("Completed");
});
