import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "pawguild-e2e";
const H = { "x-pawguild-request": "1" };

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Good day");
}

test("a grooming appointment without a groomer shows up, and clears once someone is assigned", async ({ page }) => {
  await signIn(page, "desk@harborhounds.example");
  // Tomorrow at 10:00 in the business's time zone (New York).
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() + 86_400_000));
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
    .format(new Date(`${tomorrow}T15:00:00Z`)).split("GMT")[1];
  const customer = await (await page.request.post("/api/customers", { headers: H, data: { firstName: "Zoe", lastName: "Notice" } })).json();
  const pet = await (await page.request.post("/api/pets", { headers: H, data: { customerId: customer.id, name: "Zippy", species: "dog" } })).json();
  const services = (await (await page.request.get("/api/services")).json()).items;
  const groom = services.find((s: { name: string }) => s.name === "Full Groom");
  const location = (await (await page.request.get("/api/locations")).json()).items[0];
  const booked = await page.request.post("/api/reservations", { headers: H, data: {
    customerId: customer.id, locationId: location.id, serviceId: groom.id, petIds: [pet.id],
    startsAt: `${tomorrow}T10:00:00${offset}`, endsAt: `${tomorrow}T12:00:00${offset}`, status: "confirmed",
  } });
  expect(booked.ok(), await booked.text()).toBe(true);

  await page.reload();
  const bell = page.getByRole("link", { name: /^Notifications: \d+ need attention$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notifications");
  const item = page.getByRole("link", { name: "No groomer assigned: Zippy" });
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Grooming");
  await page.getByLabel(/^Groomer for Zippy at /).selectOption({ label: "Avery Lin" });
  await expect(page.getByRole("region", { name: "Avery Lin" })).toContainText("Zippy");
  await page.getByRole("link", { name: /^Notifications/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Notifications");
  await expect(page.getByRole("link", { name: "No groomer assigned: Zippy" })).toHaveCount(0);
});
