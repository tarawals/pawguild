import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

/** Call the API as the signed-in user (shares the browser's session cookie). */
async function api(page: Page, method: "GET" | "POST", url: string, data?: unknown) {
  const res = await page.request.fetch(url, { method, headers: { "x-pawguild-request": "1" }, ...(data !== undefined && { data }) });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json();
}

test("check-out review: warnings, bill and check-out in one place", async ({ page }) => {
  // A manager sets up a stay that's due to leave (pick-up a minute ago, so it's a departure at
  // any hour; at night that's outside business hours, hence the override).
  await signIn(page, "owner@harborhounds.example");
  const locations = await api(page, "GET", "/api/locations");
  const services = await api(page, "GET", "/api/services");
  const boarding = services.items.find((s: { name: string }) => s.name === "Boarding — Standard Suite");
  const customer = await api(page, "POST", "/api/customers", { firstName: "Olive", lastName: "Checkout" });
  const pet = await api(page, "POST", "/api/pets", { customerId: customer.id, name: "Nova", species: "cat" });
  for (const vaccine of ["Rabies", "FVRCP"]) {
    await api(page, "POST", `/api/pets/${pet.id}/vaccinations`, { vaccine, expiresOn: "2029-01-01" });
  }
  const now = Date.now();
  const r = await api(page, "POST", "/api/reservations", {
    customerId: customer.id, locationId: locations.items[0].id, serviceId: boarding.id, petIds: [pet.id],
    startsAt: new Date(now - 3 * 3600_000).toISOString(), endsAt: new Date(now - 60_000).toISOString(), status: "confirmed",
    overrideHours: true,
  });
  await api(page, "POST", `/api/reservations/${r.id}/status`, { status: "checked_in" });
  await api(page, "POST", `/api/reservations/${r.id}/care-logs`, { kind: "feeding", petId: pet.id, meal: "lunch", amountEaten: "some" });
  await api(page, "POST", `/api/reservations/${r.id}/care-logs`, { kind: "note", petId: pet.id, notes: "Purred all afternoon" });
  await api(page, "POST", "/api/incidents", { petId: pet.id, reservationId: r.id, category: "illness", severity: "low", description: "Sneezed a few times" });

  // Front desk takes it from here. Dashboard "Check out" opens the review rather than checking out blind.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await signIn(page, "desk@harborhounds.example");
  await page.goto("/");
  await page.getByRole("region", { name: "Departures today" }).getByRole("link", { name: "Check out Nova" }).click();
  const panel = page.getByRole("region", { name: "Check-out" });
  const warnings = panel.getByRole("status", { name: "Check-out warnings" });
  await expect(warnings).toContainText("Nova: incident not yet shared with the owner");
  await expect(warnings).toContainText("No invoice yet");
  await expect(panel).toContainText("Fed 1 time (1 not finished)");
  await expect(panel).toContainText("“Purred all afternoon” — Jordan Reyes");
  await expect(panel).toContainText("(owner not told yet)");

  // Bill from the panel.
  await panel.getByRole("button", { name: "Create invoice" }).click();
  await page.getByRole("button", { name: "Issue invoice" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Unpaid");
  await page.getByRole("link", { name: "View reservation" }).click();
  await expect(panel).toContainText("$55.00 due");
  await panel.getByRole("link", { name: "Take payment" }).click();
  await page.getByRole("region", { name: "Payments" }).getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Paid");
  await page.getByRole("link", { name: "View reservation" }).click();
  await expect(panel).toContainText("Paid");
  await expect(warnings).not.toContainText("invoice");

  // Warnings don't block check-out.
  await panel.getByRole("button", { name: "Check out" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Completed");
  const summary = page.getByRole("region", { name: "Stay summary" });
  await expect(summary).toContainText("Fed 1 time");
  await expect(summary.getByRole("button", { name: "Check out" })).toHaveCount(0);
});

test("care attendants see the stay summary but not the bill or the check-out button", async ({ page }) => {
  await signIn(page, "care@harborhounds.example");
  await page.goto("/reservations?status=completed&from=2020-01-01&to=2030-12-31");
  await page.getByRole("row", { name: /Nova/ }).getByRole("link").first().click();
  const summary = page.getByRole("region", { name: "Stay summary" });
  await expect(summary).toContainText("Fed 1 time");
  await expect(summary).not.toContainText("Invoice");
});
