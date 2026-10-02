import { addDays, calendarDate, zonedDateTime } from "@pawguild/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
const svc: Record<string, string> = {};
const product: Record<string, string> = {};
let customerId: string;
const pets: string[] = [];
let shortInvoiceId: string;

const TZ = "America/New_York";
const today = calendarDate(new Date(), TZ);
const day = (n: number) => addDays(today, n);
const t = (n: number, time: string) => zonedDateTime(day(n), time, TZ).toISOString();

type Line = { description: string; quantity: number; unitPriceCents: number; discountCents: number };
/** Book daycare and draft its invoice; returns the invoice id and its lines. */
async function daycare(service: "full" | "half", n: number, from: string, to: string, petIdx = [0]) {
  const r = (await desk.post("/api/reservations", {
    customerId, locationId: org.locationId, serviceId: svc[service], petIds: petIdx.map((i) => pets[i]), startsAt: t(n, from), endsAt: t(n, to), status: "confirmed",
  })).json();
  const invRes = await desk.post(`/api/reservations/${r.id}/invoice`);
  if (invRes.statusCode !== 201) throw new Error(`invoice ${invRes.statusCode}: ${invRes.body} (booking: ${JSON.stringify(r).slice(0, 200)})`);
  const inv = invRes.json();
  return { id: inv.id as string, lines: (inv.lines as Line[]).map((l) => [l.description, l.quantity, l.unitPriceCents, l.discountCents]) };
}
const balances = async () => (await desk.get(`/api/customers/${customerId}/packages`)).json().items as
  { id: string; name: string; remaining: number; status: string; expiresOn: string | null; invoiceId: string; uses: { usedOn: string }[] }[];

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "manager", "front_desk", "care_attendant"]);
  owner = await login(ctx.app, org.users.owner!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  svc.full = (await owner.post("/api/services", { name: "Daycare — Full Day", category: "daycare", priceCents: 3800, priceUnit: "per_day" })).json().id;
  svc.half = (await owner.post("/api/services", { name: "Daycare — Half Day", category: "daycare", priceCents: 2600, priceUnit: "per_day" })).json().id;
  await owner.put("/api/settings/billing", {
    boardingMode: "nights", boardingExtraTime: "daycare", halfDayMaxHours: 5, gracePeriodMinutes: 30, daytimeStart: "07:00", daytimeEnd: "19:00",
    daycareFullServiceId: svc.full, daycareHalfServiceId: svc.half, additionalPetDiscountBps: 1000,
  });
  customerId = (await desk.post("/api/customers", { firstName: "Pat", lastName: "Package" })).json().id;
  for (const name of ["Ace", "Bo"]) pets.push((await desk.post("/api/pets", { customerId, name, species: "dog" })).json().id);
});
afterAll(async () => { await ctx.close(); });

describe("package products", () => {
  it("owners set them up, including how long they last; others can only look", async () => {
    const body = { name: "10 Full Days", covers: "full_day", days: 10, priceCents: 34000, expiresAfterDays: 30 };
    expect((await manager.post("/api/package-products", body)).statusCode).toBe(403);
    expect((await desk.post("/api/package-products", body)).statusCode).toBe(403);
    const bad = await owner.post("/api/package-products", { ...body, days: 0, expiresAfterDays: 0 });
    expect(bad.json().error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["days", "expiresAfterDays"]);
    const res = await owner.post("/api/package-products", body);
    expect(res.statusCode).toBe(201);
    product.full = res.json().id;
    expect((await owner.post("/api/package-products", body)).json().error.fields[0].message).toBe("There's already a package with this name");
    product.half = (await owner.post("/api/package-products", { name: "5 Half Days", covers: "half_day", days: 5, priceCents: 11000, expiresAfterDays: null })).json().id;
    expect((await desk.get("/api/package-products")).json().items.map((p: { name: string }) => p.name)).toEqual(["10 Full Days", "5 Half Days"]);
    expect((await care.get("/api/package-products")).statusCode).toBe(403);
  });
});

describe("selling and using packages", () => {
  it("sells a package on an issued invoice", async () => {
    const res = await desk.post(`/api/customers/${customerId}/packages`, { productId: product.full });
    expect(res.statusCode).toBe(201);
    const inv = (await desk.get(`/api/invoices/${res.json().invoiceId}`)).json();
    expect(inv).toMatchObject({ status: "issued", totals: { totalCents: 34000 } });
    expect(inv.lines[0].description).toMatch(/^10 Full Days — 10 full days of daycare, use by /);
    const [pkg] = await balances();
    expect(pkg).toMatchObject({ name: "10 Full Days", remaining: 10, status: "active", expiresOn: day(30) });
  });

  it("uses a full day from the package; half days are charged without a half-day package", async () => {
    expect((await daycare("full", 2, "08:00", "17:00")).lines).toEqual([["Daycare — Full Day — Ace (1 day prepaid: 10 Full Days)", 1, 0, 0]]);
    expect((await balances())[0]).toMatchObject({ remaining: 9, uses: [{ usedOn: day(2) }] });
    // A short day is a half day, which the full-day package doesn't cover.
    expect((await daycare("full", 3, "08:00", "12:00")).lines).toEqual([["Daycare — Half Day — Ace (1 day)", 1, 2600, 0]]);
    await desk.post(`/api/customers/${customerId}/packages`, { productId: product.half });
    expect((await daycare("half", 4, "08:00", "12:00")).lines).toEqual([["Daycare — Half Day — Ace (1 day prepaid: 5 Half Days)", 1, 0, 0]]);
  });

  it("two dogs use two days; when the package runs short the rest is charged, with the additional-pet discount", async () => {
    const both = await daycare("full", 5, "08:00", "17:00", [0, 1]);
    expect(both.lines).toEqual([["Daycare — Full Day — Ace, Bo (2 days prepaid: 10 Full Days)", 2, 0, 0]]);
    // 7 days left: use up 6 more one at a time, leaving 1.
    for (let n = 6; n < 12; n++) await daycare("full", n, "08:00", "17:00");
    expect((await balances()).find((p) => p.name === "10 Full Days")!.remaining).toBe(1);
    const short = await daycare("full", 12, "08:00", "17:00", [0, 1]);
    shortInvoiceId = short.id;
    expect(short.lines).toEqual([
      ["Daycare — Full Day — Ace, Bo (1 charged across pets)", 1, 3800, 380],
      ["Daycare — Full Day — Ace, Bo (1 day prepaid: 10 Full Days)", 1, 0, 0],
    ]);
    expect((await balances()).find((p) => p.name === "10 Full Days")).toMatchObject({ remaining: 0, status: "used_up" });
  });

  it("voiding an invoice or deleting the prepaid line gives the days back", async () => {
    const pkg = () => balances().then((b) => b.find((p) => p.name === "10 Full Days")!);
    await desk.post(`/api/invoices/${shortInvoiceId}/void`, { reason: "Re-doing" });
    expect((await pkg()).remaining).toBe(1);
    const again = (await desk.get(`/api/invoices/${(await daycare("full", 13, "08:00", "17:00")).id}`)).json();
    expect((await pkg()).remaining).toBe(0);
    const prepaid = again.lines.find((l: { unitPriceCents: number }) => l.unitPriceCents === 0);
    expect((await desk.delete(`/api/invoices/${again.id}/lines/${prepaid.id}`)).statusCode).toBe(200);
    expect((await pkg()).remaining).toBe(1);
  });

  it("an expired package isn't used", async () => {
    expect((await daycare("full", 31, "08:00", "17:00")).lines).toEqual([["Daycare — Full Day — Ace (1 day)", 1, 3800, 0]]);
    expect((await balances()).find((p) => p.name === "10 Full Days")!.remaining).toBe(1);
  });

  it("two invoices at once can't both spend the last day", async () => {
    const results = await Promise.all([14, 15].map((n) => daycare("full", n, "08:00", "17:00")));
    const prepaid = results.filter((r) => r.lines.some((l) => l[2] === 0));
    expect(prepaid).toHaveLength(1);
    expect((await balances()).find((p) => p.name === "10 Full Days")!.remaining).toBe(0);
  });

  it("a package sale can't be voided once its days are used; an unused one can, and is then unusable", async () => {
    const full = (await balances()).find((p) => p.name === "10 Full Days")!;
    const blocked = await owner.post(`/api/invoices/${full.invoiceId}/void`, { reason: "Mistake" });
    expect(blocked.json().error.code).toBe("package_in_use");
    const sold = (await desk.post(`/api/customers/${customerId}/packages`, { productId: product.full })).json();
    expect((await owner.post(`/api/invoices/${sold.invoiceId}/void`, { reason: "Sold by mistake" })).statusCode).toBe(200);
    expect((await balances()).find((p) => p.id === sold.packageId)).toMatchObject({ status: "void" });
    expect((await daycare("full", 16, "08:00", "17:00")).lines).toEqual([["Daycare — Full Day — Ace (1 day)", 1, 3800, 0]]);
  });

  it("changing a package's terms doesn't change packages already sold", async () => {
    await owner.patch(`/api/package-products/${product.full}`, { expiresAfterDays: 365, priceCents: 36000 });
    expect((await balances()).find((p) => p.name === "10 Full Days" && p.status !== "void")!.expiresOn).toBe(day(30));
    const audit = (await owner.get(`/api/audit?entityType=package_product&entityId=${product.full}`)).json().items[0];
    expect(audit.changes).toMatchObject({ expiresAfterDays: { from: 30, to: 365 }, priceCents: { from: 34000, to: 36000 } });
  });

  it("other organizations can't sell our packages or see our customers' balances", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    const theirCustomer = (await outsider.post("/api/customers", { firstName: "O", lastName: "T" })).json().id;
    expect((await outsider.post(`/api/customers/${theirCustomer}/packages`, { productId: product.full })).json().error.fields[0].path).toBe("productId");
    expect((await outsider.get(`/api/customers/${customerId}/packages`)).statusCode).toBe(404);
    expect((await outsider.get("/api/package-products")).json().items).toEqual([]);
  });
});
