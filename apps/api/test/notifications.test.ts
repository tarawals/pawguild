import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let employee: Awaited<ReturnType<typeof login>>;
let customerId: string;
const svc: Record<string, string> = {};
const now = Date.now();
const iso = (hoursFromNow: number) => new Date(now + hoursFromNow * 3_600_000).toISOString();

type Item = { id: string; kind: string; severity: string; title: string; detail?: string; link: string };
const list = async (client: typeof desk) => (await client.get("/api/notifications")).json() as { items: Item[]; counts: Record<string, number>; total: number };
const kinds = async (client: typeof desk) => (await list(client)).items.map((i) => i.kind);
const pet = async (name: string) => (await desk.post("/api/pets", { customerId, name, species: "dog" })).json().id as string;
const book = async (service: string, petIds: string[], from: number, to: number, extra: object = {}) =>
  (await manager.post("/api/reservations", { customerId, locationId: org.locationId, serviceId: svc[service], petIds, startsAt: iso(from), endsAt: iso(to), status: "confirmed", ...extra })).json();

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant", "employee"]);
  // A fixed-offset zone where it's about noon, so "3 hours ago" and "in 4 hours" are always today.
  const x = new Date().getUTCHours() - 12;
  await ctx.ownerDb.updateTable("organizations").set({ timezone: `Etc/GMT${x >= 0 ? "+" : "-"}${Math.abs(x)}` }).where("id", "=", org.orgId).execute();
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  employee = await login(ctx.app, org.users.employee!.email);
  for (const [name, category, priceUnit] of [["Boarding", "boarding", "per_night"], ["Groom", "grooming", "per_visit"], ["Daycare", "daycare", "per_day"]]) {
    svc[name!] = (await manager.post("/api/services", { name, category, priceCents: 5000, priceUnit })).json().id;
  }
  customerId = (await desk.post("/api/customers", { firstName: "Nora", lastName: "Notify" })).json().id;
});
afterAll(async () => { await ctx.close(); });

describe("notifications", () => {
  it("are empty when nothing needs attention", async () => {
    expect(await list(manager)).toEqual({ items: [], counts: { high: 0, medium: 0, low: 0 }, total: 0 });
  });

  it("flag overdue medication and pets past pick-up, and clear once handled", async () => {
    const rex = await pet("Rex");
    const localHour = (h: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .format(new Date(now + h * 3_600_000 - (new Date().getUTCHours() - 12) * 3_600_000));
    const med = (await desk.post(`/api/pets/${rex}/medications`, { name: "Carprofen", dosage: "25 mg", times: [localHour(-3)] })).json();
    const stay = await book("Boarding", [rex], -5, -2);
    expect((await desk.post(`/api/reservations/${stay.id}/status`, { status: "checked_in" })).statusCode).toBe(200);

    const items = (await list(care)).items;
    expect(items[0]).toMatchObject({ kind: "medication_overdue", severity: "high", title: "Medication overdue: Rex — Carprofen", link: "/care" });
    expect(items.find((i) => i.kind === "past_pickup")).toMatchObject({ severity: "medium", title: "Past pick-up time: Rex", link: `/reservations/${stay.id}` });
    // The employee role can see stays but can't record care, so no medication item.
    expect(await kinds(employee)).toEqual(["past_pickup"]);

    const scheduledFor = JSON.stringify((await care.get("/api/care/today")).json()).match(/"scheduledFor":"([^"]+)"/)![1];
    const logged = await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "medication", petId: rex, medicationId: med.id, scheduledFor, status: "given" });
    expect(logged.statusCode).toBe(201);
    await desk.post(`/api/reservations/${stay.id}/status`, { status: "completed" });
    expect(await kinds(care)).toEqual([]);
  });

  it("flag arrivals that need vaccinations and bookings not yet confirmed", async () => {
    await manager.patch(`/api/services/${svc.Daycare}`, { vaccineRequirements: { dog: ["Rabies"] } });
    const bo = await pet("Bo");
    const r = await book("Daycare", [bo], 3, 6, { status: "pending" });
    const items = (await list(desk)).items;
    expect(items.map((i) => [i.kind, i.severity])).toEqual([["vaccinations_needed", "medium"], ["unconfirmed", "low"]]);
    expect(items[0]!.title).toBe("Vaccinations needed before check-in: Bo");
    await desk.post(`/api/pets/${bo}/vaccinations`, { vaccine: "Rabies", expiresOn: "2030-01-01" });
    await desk.post(`/api/reservations/${r.id}/status`, { status: "confirmed" });
    expect(await kinds(desk)).toEqual([]);
  });

  it("flag grooming without a groomer (more urgent when it's today)", async () => {
    const cy = await pet("Cy");
    const r = await book("Groom", [cy], 4, 5);
    expect((await list(care)).items).toEqual([expect.objectContaining({ kind: "no_groomer", severity: "medium", title: "No groomer assigned: Cy" })]);
    const staff = (await manager.get("/api/grooming/staff")).json().items;
    await manager.put(`/api/grooming/appointments/${r.id}/groomer`, { membershipId: staff[0].membershipId });
    expect(await kinds(care)).toEqual([]);
  });

  it("flag serious or follow-up incidents until a manager resolves them", async () => {
    const di = await pet("Di");
    const inc = (await care.post("/api/incidents", { petId: di, category: "injury", severity: "high", description: "Cut paw" })).json();
    expect((await list(employee)).items).toEqual([expect.objectContaining({ kind: "open_incident", severity: "high", title: "Serious incident: Di (injury)" })]);
    expect((await list(care)).items[0]!.detail).toBe("Owner not told yet. A manager needs to resolve it.");
    expect((await list(manager)).items[0]!.detail).toBe("Owner not told yet. Review and resolve it.");
    expect((await manager.patch(`/api/incidents/${inc.id}`, { actionsTaken: "Cleaned and bandaged", ownerNotified: true, resolution: "Healed" })).statusCode).toBe(200);
    expect(await kinds(manager)).toEqual([]);
  });

  it("flag over-capacity nights and overpaid invoices, to the right people", async () => {
    await ctx.ownerDb.insertInto("locationCapacities").values({ organizationId: org.orgId, locationId: org.locationId, category: "boarding", maxPets: 1 })
      .onConflict((oc) => oc.columns(["locationId", "category"]).doUpdateSet({ maxPets: 1 })).execute();
    const [ed, fi] = [await pet("Ed"), await pet("Fi")];
    await book("Boarding", [ed], 2, 26);
    await book("Boarding", [fi], 3, 27, { overrideCapacity: true });
    expect((await list(employee)).items).toEqual([expect.objectContaining({ kind: "over_capacity", severity: "high", title: "Boarding over capacity tonight at Main" })]);

    const inv = (await desk.post("/api/invoices", { customerId, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${inv.id}/lines`, { description: "Bath", quantity: 1, unitPriceCents: 3000 });
    await desk.post(`/api/invoices/${inv.id}/issue`);
    await desk.post(`/api/invoices/${inv.id}/payments`, { amountCents: 3000, method: "cash" });
    await manager.post(`/api/invoices/${inv.id}/credit-notes`, { amountCents: 1000, reason: "Goodwill" });
    const deskItems = (await list(desk)).items;
    expect(deskItems.find((i) => i.kind === "overpaid_invoices")).toMatchObject({ title: "1 overpaid invoice", detail: "A manager needs to refund or move it to account credit." });
    expect(await kinds(care)).not.toContain("overpaid_invoices");
    await ctx.ownerDb.deleteFrom("locationCapacities").where("locationId", "=", org.locationId).execute();
    await manager.post(`/api/invoices/${inv.id}/refunds`, { amountCents: 1000, method: "cash", reason: "Goodwill" });
  });

  it("flag unstaffed open days for managers once the business uses the schedule", async () => {
    expect(await kinds(manager)).not.toContain("unstaffed_day");
    const staff = (await manager.get("/api/grooming/staff")).json().items;
    await manager.post("/api/shifts", { locationId: org.locationId, membershipId: staff[0].membershipId, startsAt: iso(-1), endsAt: iso(3) });
    const unstaffed = (await list(manager)).items.filter((i) => i.kind === "unstaffed_day");
    expect(unstaffed).toHaveLength(6); // today is covered; the next six days aren't
    expect(unstaffed.every((i) => i.severity === "medium" && i.link.startsWith("/schedule?week="))).toBe(true);
    expect(await kinds(desk)).not.toContain("unstaffed_day");
  });

  it("never show another organization's problems", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await list(outsider)).total).toBe(0);
  });
});
