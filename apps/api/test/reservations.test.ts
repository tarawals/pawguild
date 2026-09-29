import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let boarding: { id: string };
let customer: { id: string };
let rex: { id: string };
let luna: { id: string };

// New York organization (default timezone). Times below carry explicit offsets.
const at = (d: string, t: string) => `${d}T${t}:00-04:00`;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5500, priceUnit: "per_night" })).json();
  customer = (await desk.post("/api/customers", { firstName: "Ada", lastName: "Lane" })).json();
  rex = (await desk.post("/api/pets", { customerId: customer.id, name: "Rex", species: "dog" })).json();
  luna = (await desk.post("/api/pets", { customerId: customer.id, name: "Luna", species: "dog" })).json();
});
afterAll(async () => { await ctx.close(); });

const book = (overrides: Record<string, unknown> = {}) => desk.post("/api/reservations", {
  customerId: customer.id, locationId: org.locationId, serviceId: boarding.id,
  petIds: [rex.id, luna.id], startsAt: at("2026-07-01", "14:00"), endsAt: at("2026-07-04", "11:00"), ...overrides,
});

describe("services", () => {
  it("lets managers configure services and blocks front desk", async () => {
    const res = await desk.post("/api/services", { name: "Nope", category: "daycare", priceCents: 100, priceUnit: "per_day" });
    expect(res.statusCode).toBe(403);
    const bad = await manager.post("/api/services", { name: "Bad", category: "daycare", priceCents: 12.5, priceUnit: "per_day" });
    expect(bad.statusCode).toBe(400);
    const list = await desk.get("/api/services");
    expect(list.json().items.map((s: { name: string }) => s.name)).toContain("Boarding");
  });
});

describe("reservations", () => {
  it("books multiple pets with a price snapshot and walks the full lifecycle", async () => {
    const res = await book();
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r.status).toBe("pending");
    expect(r.pets.map((p: { name: string }) => p.name)).toEqual(["Luna", "Rex"]);
    expect(r.estimate).toEqual({ quantity: 3, petCount: 2, unitPriceCents: 5500, totalCents: 33000 });
    expect(r.allowedTransitions).toEqual(["confirmed", "cancelled"]);

    // A later price change does not alter the booked price.
    await manager.patch(`/api/services/${boarding.id}`, { priceCents: 6000 });
    expect((await desk.get(`/api/reservations/${r.id}`)).json().estimate.unitPriceCents).toBe(5500);

    const skip = await desk.post(`/api/reservations/${r.id}/status`, { status: "completed" });
    expect(skip.statusCode).toBe(409);
    expect(skip.json().error.code).toBe("invalid_transition");

    expect((await desk.post(`/api/reservations/${r.id}/status`, { status: "confirmed" })).json().confirmedAt).not.toBeNull();
    const checkedIn = (await desk.post(`/api/reservations/${r.id}/status`, { status: "checked_in" })).json();
    expect(checkedIn.status).toBe("checked_in");
    expect((await desk.patch(`/api/reservations/${r.id}`, { notes: "late edit" })).statusCode).toBe(409);
    const done = (await desk.post(`/api/reservations/${r.id}/status`, { status: "completed" })).json();
    expect(done.status).toBe("completed");
    expect(done.allowedTransitions).toEqual([]);

    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${r.id}`)).json().items;
    expect(audit.map((a: { action: string }) => a.action)).toEqual([
      "reservation.completed", "reservation.checked_in", "reservation.confirmed", "reservation.created",
    ]);
  });

  it("prevents double-booking a pet and allows it again after cancellation", async () => {
    const first = (await book({ petIds: [rex.id], startsAt: at("2026-08-01", "14:00"), endsAt: at("2026-08-03", "11:00") })).json();
    const clash = await book({ petIds: [luna.id, rex.id], startsAt: at("2026-08-02", "09:00"), endsAt: at("2026-08-05", "11:00") });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toMatch(/Rex already has a reservation/);

    // Back-to-back (ends exactly when the next starts) is fine.
    const adjacent = await book({ petIds: [rex.id], startsAt: at("2026-08-03", "11:00"), endsAt: at("2026-08-04", "11:00") });
    expect(adjacent.statusCode).toBe(201);

    const noReason = await desk.post(`/api/reservations/${first.id}/status`, { status: "cancelled" });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.fields[0].path).toBe("reason");
    const cancelled = await desk.post(`/api/reservations/${first.id}/status`, { status: "cancelled", reason: "Customer called" });
    expect(cancelled.json()).toMatchObject({ status: "cancelled", cancellationReason: "Customer called" });
    expect((await book({ petIds: [rex.id], startsAt: at("2026-08-02", "09:00"), endsAt: at("2026-08-03", "10:00") })).statusCode).toBe(201);
  });

  it("reschedules and changes pets while pending, re-checking conflicts", async () => {
    const r = (await book({ petIds: [rex.id], startsAt: at("2026-09-10", "08:00"), endsAt: at("2026-09-11", "18:00") })).json();
    const moved = await desk.patch(`/api/reservations/${r.id}`, { petIds: [rex.id, luna.id], endsAt: at("2026-09-12", "18:00") });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().estimate).toMatchObject({ quantity: 2, petCount: 2 });
    const inverted = await desk.patch(`/api/reservations/${r.id}`, { endsAt: at("2026-09-01", "08:00") });
    expect(inverted.statusCode).toBe(400);
  });

  it("validates input, pet ownership and customer state", async () => {
    const backwards = await book({ startsAt: at("2026-10-05", "10:00"), endsAt: at("2026-10-01", "10:00") });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.fields.map((f: { path: string }) => f.path)).toContain("endsAt");

    const other = (await desk.post("/api/customers", { firstName: "Other", lastName: "Owner" })).json();
    const otherPet = (await desk.post("/api/pets", { customerId: other.id, name: "Stray", species: "cat" })).json();
    const wrongOwner = await book({ petIds: [otherPet.id], startsAt: at("2026-10-01", "10:00"), endsAt: at("2026-10-02", "10:00") });
    expect(wrongOwner.statusCode).toBe(422);

    await desk.patch(`/api/pets/${luna.id}`, { status: "inactive" });
    const inactive = await book({ petIds: [luna.id], startsAt: at("2026-10-01", "10:00"), endsAt: at("2026-10-02", "10:00") });
    expect(inactive.statusCode).toBe(422);
    await desk.patch(`/api/pets/${luna.id}`, { status: "active" });

    await manager.patch(`/api/services/${boarding.id}`, { isActive: false });
    expect((await book({ startsAt: at("2026-10-01", "10:00"), endsAt: at("2026-10-02", "10:00") })).statusCode).toBe(422);
    await manager.patch(`/api/services/${boarding.id}`, { isActive: true });
  });

  it("enforces permissions on booking and status changes", async () => {
    const r = (await book({ petIds: [luna.id], startsAt: at("2026-11-01", "10:00"), endsAt: at("2026-11-02", "10:00"), status: "confirmed" })).json();
    expect((await care.post("/api/reservations", {})).statusCode).toBe(403);
    expect((await care.post(`/api/reservations/${r.id}/status`, { status: "cancelled", reason: "x" })).statusCode).toBe(403);
    expect((await care.get(`/api/reservations/${r.id}`)).statusCode).toBe(200);
  });

  it("lists reservations by date range, customer and pet", async () => {
    const res = await desk.get(`/api/reservations?customerId=${customer.id}&from=${encodeURIComponent(at("2026-08-01", "00:00"))}&to=${encodeURIComponent(at("2026-08-31", "23:59"))}`);
    const items = res.json().items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i.customerName).toBe("Ada Lane");
    const byPet = (await desk.get(`/api/reservations?petId=${luna.id}`)).json().items;
    for (const i of byPet) expect(i.petNames).toContain("Luna");
  });
});

describe("reservation tenant isolation", () => {
  it("cannot read, change or book across organizations", async () => {
    const r = (await book({ petIds: [rex.id], startsAt: at("2026-12-01", "10:00"), endsAt: at("2026-12-02", "10:00") })).json();
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    expect((await intruder.get(`/api/reservations/${r.id}`)).statusCode).toBe(404);
    expect((await intruder.post(`/api/reservations/${r.id}/status`, { status: "confirmed" })).statusCode).toBe(404);
    expect((await intruder.patch(`/api/reservations/${r.id}`, { notes: "x" })).statusCode).toBe(404);
    expect((await intruder.get("/api/reservations")).json().items).toHaveLength(0);
    expect((await intruder.get("/api/services")).json().items).toHaveLength(0);

    // Using another org's customer, pet, service or location is rejected.
    const svc = (await intruder.post("/api/services", { name: "X", category: "daycare", priceCents: 100, priceUnit: "per_day" })).json();
    const res = await intruder.post("/api/reservations", {
      customerId: customer.id, locationId: other.locationId, serviceId: svc.id, petIds: [rex.id],
      startsAt: at("2026-12-05", "10:00"), endsAt: at("2026-12-06", "10:00"),
    });
    expect(res.statusCode).toBe(422);
    const own = (await intruder.post("/api/customers", { firstName: "I", lastName: "N" })).json();
    const ownPet = (await intruder.post("/api/pets", { customerId: own.id, name: "P", species: "dog" })).json();
    const res2 = await intruder.post("/api/reservations", {
      customerId: own.id, locationId: org.locationId, serviceId: boarding.id, petIds: [ownPet.id],
      startsAt: at("2026-12-05", "10:00"), endsAt: at("2026-12-06", "10:00"),
    });
    expect(res2.statusCode).toBe(422);
  });
});

describe("dashboard", () => {
  it("shows today's arrivals and pets checked in", async () => {
    // Run in a fixed-offset zone where it's about noon, so a one-hour stay never crosses local
    // midnight (this test previously failed between 11pm and midnight New York time).
    const x = new Date().getUTCHours() - 12;
    await ctx.ownerDb.updateTable("organizations").set({ timezone: `Etc/GMT${x >= 0 ? "+" : "-"}${Math.abs(x)}` })
      .where("id", "=", org.orgId).execute();
    const pet = (await desk.post("/api/pets", { customerId: customer.id, name: "Dot", species: "dog" })).json();
    const now = new Date();
    const r = (await desk.post("/api/reservations", {
      customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [pet.id],
      startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 3600_000).toISOString(), status: "confirmed",
    })).json();
    let summary = (await desk.get("/api/dashboard/summary")).json();
    expect(summary.arrivals.map((a: { id: string }) => a.id)).toContain(r.id);

    await desk.post(`/api/reservations/${r.id}/status`, { status: "checked_in" });
    summary = (await desk.get("/api/dashboard/summary")).json();
    expect(summary.arrivals.map((a: { id: string }) => a.id)).not.toContain(r.id);
    expect(summary.departures.map((a: { id: string }) => a.id)).toContain(r.id);
    expect(summary.petsCheckedIn).toBeGreaterThanOrEqual(1);
  });
});
