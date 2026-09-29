import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let stay: { id: string };
let rex: { id: string };
let tz: string;
const localTime = (offsetMin: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + offsetMin * 60_000));

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant"]);
  const x = new Date().getUTCHours() - 12; // a zone where it's about noon, so today's doses are stable
  tz = `Etc/GMT${x >= 0 ? "+" : "-"}${Math.abs(x)}`;
  await ctx.ownerDb.updateTable("organizations").set({ timezone: tz }).where("id", "=", org.orgId).execute();
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  const svc = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json();
  const customer = (await desk.post("/api/customers", { firstName: "Out", lastName: "Going" })).json();
  rex = (await desk.post("/api/pets", { customerId: customer.id, name: "Rex", species: "dog" })).json();
  const med = (await desk.post(`/api/pets/${rex.id}/medications`, { name: "Apoquel", dosage: "16mg", times: [localTime(-120), localTime(60)] })).json();
  stay = (await desk.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: svc.id, petIds: [rex.id],
    startsAt: new Date(Date.now() - 6 * 3600_000).toISOString(), endsAt: new Date(Date.now() + 3 * 3600_000).toISOString(), status: "confirmed",
  })).json();
  await desk.post(`/api/reservations/${stay.id}/status`, { status: "checked_in" });
  const doses = (await care.get("/api/care/today")).json().stays[0].pets[0].doses;
  await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "medication", petId: rex.id, medicationId: med.id, status: "given", scheduledFor: doses[0].scheduledFor });
  await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "feeding", petId: rex.id, meal: "breakfast", amountEaten: "all" });
  await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "feeding", petId: rex.id, meal: "dinner", amountEaten: "some" });
  await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "potty", petId: rex.id });
  const oops = (await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "walk", petId: rex.id })).json();
  await care.post(`/api/care-logs/${oops.id}/void`, { reason: "wrong dog" });
  await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "note", petId: rex.id, notes: "Loved the ball pit" });
  await care.post("/api/incidents", { petId: rex.id, reservationId: stay.id, category: "injury", severity: "low", description: "Scratch" });
});
afterAll(async () => { await ctx.close(); });

describe("check-out summary", () => {
  it("summarizes the stay's care, ignoring voided entries", async () => {
    const s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    const pet = s.pets[0];
    expect(pet.counts).toEqual({ feeding: 2, medication: 1, potty: 1, walk: 0, play: 0, rest: 0 });
    expect(pet.mealsNotFinished).toBe(1);
    expect(pet.medicationsGiven).toEqual([expect.objectContaining({ name: "Apoquel", dose: "16mg", status: "given" })]);
    expect(pet.notes.map((n: { text: string }) => n.text)).toEqual(["Loved the ball pit"]);
    expect(pet.dosesNotRecorded).toEqual([expect.objectContaining({ medicationName: "Apoquel", status: "due" })]);
  });

  it("warns about unrecorded doses, incidents the owner hasn't heard about, and billing", async () => {
    let s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.warnings).toEqual(["Rex: 1 medication dose today not recorded", "Rex: incident not yet shared with the owner", "No invoice yet"]);

    const inc = (await desk.get(`/api/incidents?reservationId=${stay.id}`)).json().items[0];
    await desk.patch(`/api/incidents/${inc.id}`, { ownerNotified: true });
    const inv = (await desk.post(`/api/reservations/${stay.id}/invoice`)).json();
    s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.warnings).toEqual(["Rex: 1 medication dose today not recorded", "Rex: 1 open incident", "Invoice is still a draft"]);

    await desk.post(`/api/invoices/${inv.id}/issue`);
    s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.billing.invoice).toMatchObject({ status: "issued", balanceCents: 5000, paymentStatus: "unpaid" });
    expect(s.warnings).toContain("Invoice not fully paid");

    await desk.post(`/api/invoices/${inv.id}/payments`, { amountCents: 5000, method: "card" });
    await manager.patch(`/api/incidents/${inc.id}`, { resolution: "Healed" });
    s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.warnings).toEqual(["Rex: 1 medication dose today not recorded"]);
  });

  it("hides billing from roles without billing access", async () => {
    const s = (await care.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.billing).toBeNull();
    expect(s.warnings.join(" ")).not.toMatch(/invoice/i);
  });

  it("stops listing today's doses once the pet has gone home", async () => {
    await desk.post(`/api/reservations/${stay.id}/status`, { status: "completed" });
    const s = (await desk.get(`/api/reservations/${stay.id}/checkout-summary`)).json();
    expect(s.status).toBe("completed");
    expect(s.pets[0].dosesNotRecorded).toEqual([]);
    expect(s.pets[0].counts.feeding).toBe(2); // the care record stays
  });

  it("is private to the organization", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    expect((await intruder.get(`/api/reservations/${stay.id}/checkout-summary`)).statusCode).toBe(404);
  });
});
