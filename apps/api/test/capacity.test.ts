import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let boarding: { id: string };
let daycare: { id: string };
let customer: { id: string };
const pets: { id: string; name: string }[] = [];

const at = (d: string, t: string) => `${d}T${t}:00-04:00`; // organization is in New York

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "manager", "front_desk"]);
  owner = await login(ctx.app, org.users.owner!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json();
  daycare = (await manager.post("/api/services", { name: "Daycare", category: "daycare", priceCents: 3000, priceUnit: "per_day" })).json();
  customer = (await desk.post("/api/customers", { firstName: "Cap", lastName: "Acity" })).json();
  for (const name of ["A", "B", "C", "D"]) pets.push((await desk.post("/api/pets", { customerId: customer.id, name, species: "dog" })).json());
});
afterAll(async () => { await ctx.close(); });

const book = (serviceId: string, petIds: string[], startsAt: string, endsAt: string, extra: Record<string, unknown> = {}) =>
  desk.post("/api/reservations", { customerId: customer.id, locationId: org.locationId, serviceId, petIds, startsAt, endsAt, ...extra });

describe("location capacity limits", () => {
  it("only lets location managers set limits, and audits changes", async () => {
    expect((await desk.put(`/api/locations/${org.locationId}/capacity`, { daycare: 2, boarding: 2 })).statusCode).toBe(403);
    expect((await owner.put(`/api/locations/${org.locationId}/capacity`, { daycare: 2, boarding: 2 })).statusCode).toBe(200);
    const loc = (await desk.get("/api/locations")).json().items[0];
    expect(loc.capacity).toEqual({ daycare: 2, boarding: 2 });
    const audit = (await owner.get(`/api/audit?entityType=location&entityId=${org.locationId}`)).json().items[0];
    expect(audit.changes).toEqual({ daycare: { from: null, to: 2 }, boarding: { from: null, to: 2 } });
  });

  it("blocks boarding when any night is full and names the nights", async () => {
    expect((await book(boarding.id, [pets[0]!.id, pets[1]!.id], at("2026-07-01", "14:00"), at("2026-07-03", "11:00"))).statusCode).toBe(201);
    // Night of Jul 3 is free; Jul 2 is full.
    const res = await book(boarding.id, [pets[2]!.id], at("2026-07-02", "14:00"), at("2026-07-04", "11:00"));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("capacity_full");
    expect(res.json().error.message).toMatch(/Boarding is full for this night: Jul 2 \(2\/2 booked\)/);
    // Checking out on Jul 3 frees the night of Jul 3.
    expect((await book(boarding.id, [pets[2]!.id], at("2026-07-03", "14:00"), at("2026-07-04", "11:00"))).statusCode).toBe(201);
  });

  it("counts daycare per day and ignores cancelled reservations", async () => {
    const first = (await book(daycare.id, [pets[0]!.id, pets[1]!.id], at("2026-07-10", "07:30"), at("2026-07-10", "18:00"))).json();
    expect((await book(daycare.id, [pets[2]!.id], at("2026-07-10", "08:00"), at("2026-07-10", "12:00"))).statusCode).toBe(409);
    await desk.post(`/api/reservations/${first.id}/status`, { status: "cancelled", reason: "Sick" });
    expect((await book(daycare.id, [pets[2]!.id], at("2026-07-10", "08:00"), at("2026-07-10", "12:00"))).statusCode).toBe(201);
    // Boarding and daycare limits are independent.
    expect((await book(boarding.id, [pets[3]!.id], at("2026-07-10", "14:00"), at("2026-07-11", "11:00"))).statusCode).toBe(201);
  });

  it("re-checks capacity when rescheduling or adding pets, excluding the reservation itself", async () => {
    const r = (await book(daycare.id, [pets[0]!.id], at("2026-07-20", "07:30"), at("2026-07-20", "18:00"))).json();
    await book(daycare.id, [pets[1]!.id], at("2026-07-21", "07:30"), at("2026-07-21", "18:00"));
    await book(daycare.id, [pets[2]!.id], at("2026-07-21", "07:30"), at("2026-07-21", "18:00"));
    expect((await desk.patch(`/api/reservations/${r.id}`, { notes: "same day, still fits" })).statusCode).toBe(200);
    const move = await desk.patch(`/api/reservations/${r.id}`, { startsAt: at("2026-07-21", "07:30"), endsAt: at("2026-07-21", "18:00") });
    expect(move.statusCode).toBe(409);
    expect((await desk.patch(`/api/reservations/${r.id}`, { petIds: [pets[0]!.id, pets[3]!.id] })).statusCode).toBe(200);
  });

  it("lets managers (not front desk) book over capacity, with the override audited", async () => {
    const args = [daycare.id, [pets[3]!.id], at("2026-07-21", "08:00"), at("2026-07-21", "17:00")] as const;


    const res = await manager.post("/api/reservations", {
      customerId: customer.id, locationId: org.locationId, serviceId: daycare.id, petIds: [pets[3]!.id],
      startsAt: args[2], endsAt: args[3], overrideCapacity: true,
    });
    expect(res.statusCode).toBe(201);
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${res.json().id}`)).json().items[0];
    expect(audit.changes.capacityOverride).toEqual([{ period: "2026-07-21", booked: 2, limit: 2 }]);
  });

  it("removing a limit allows booking again", async () => {
    await owner.put(`/api/locations/${org.locationId}/capacity`, { daycare: null, boarding: 2 });
    expect((await book(daycare.id, [pets[1]!.id], at("2026-07-10", "08:00"), at("2026-07-10", "09:00"))).statusCode).toBe(201);
  });

  it("shows today's occupancy on the dashboard", async () => {
    const now = new Date();
    await book(boarding.id, [pets[0]!.id], now.toISOString(), new Date(now.getTime() + 86400_000).toISOString());
    const occ = (await desk.get("/api/dashboard/summary")).json().occupancy[0];
    expect(occ.boarding).toMatchObject({ booked: 1, limit: 2 });
    expect(occ.daycare.limit).toBeNull();
  });
});

describe("kennels and rooms", () => {
  let k1: { id: string };
  let suite: { id: string };

  it("lets managers set up resources; front desk cannot", async () => {
    await owner.put(`/api/locations/${org.locationId}/capacity`, { daycare: null, boarding: null }); // kennels are the limit here
    expect((await desk.post("/api/resources", { locationId: org.locationId, name: "K1", kind: "kennel", capacity: 1 })).statusCode).toBe(403);
    k1 = (await manager.post("/api/resources", { locationId: org.locationId, name: "K1", kind: "kennel", capacity: 1 })).json();
    suite = (await manager.post("/api/resources", { locationId: org.locationId, name: "Suite", kind: "suite", capacity: 2 })).json();
    expect((await manager.post("/api/resources", { locationId: org.locationId, name: "K1", kind: "kennel", capacity: 1 })).statusCode).toBe(409);
  });

  it("assigns pets to kennels and refuses overfilling during overlapping stays", async () => {
    const r1 = (await book(boarding.id, [pets[0]!.id, pets[1]!.id], at("2026-09-01", "14:00"), at("2026-09-02", "11:00"))).json();
    const both = await desk.put(`/api/reservations/${r1.id}/assignments`, { assignments: [
      { petId: pets[0]!.id, resourceId: k1.id }, { petId: pets[1]!.id, resourceId: k1.id },
    ] });
    expect(both.statusCode).toBe(409);
    expect(both.json().error.code).toBe("resource_full");
    const ok = await desk.put(`/api/reservations/${r1.id}/assignments`, { assignments: [
      { petId: pets[0]!.id, resourceId: k1.id }, { petId: pets[1]!.id, resourceId: suite.id },
    ] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pets.map((p: { resourceName: string }) => p.resourceName).sort()).toEqual(["K1", "Suite"]);

    const r2 = (await book(boarding.id, [pets[2]!.id], at("2026-09-01", "15:00"), at("2026-09-02", "10:00"))).json();
    expect((await desk.put(`/api/reservations/${r2.id}/assignments`, { assignments: [{ petId: pets[2]!.id, resourceId: k1.id }] })).statusCode).toBe(409);
    expect((await desk.put(`/api/reservations/${r2.id}/assignments`, { assignments: [{ petId: pets[2]!.id, resourceId: suite.id }] })).statusCode).toBe(200);

    const avail = (await desk.get(`/api/resources/availability?locationId=${org.locationId}&startsAt=${encodeURIComponent(at("2026-09-01", "16:00"))}&endsAt=${encodeURIComponent(at("2026-09-01", "20:00"))}`)).json().items;
    expect(avail.find((a: { name: string }) => a.name === "K1")).toMatchObject({ occupied: 1, available: 0 });
    expect(avail.find((a: { name: string }) => a.name === "Suite")).toMatchObject({ occupied: 2, available: 0 });

    // Clearing an assignment frees the space; audit records the moves.
    await desk.put(`/api/reservations/${r1.id}/assignments`, { assignments: [{ petId: pets[0]!.id, resourceId: null }] });
    expect((await desk.put(`/api/reservations/${r2.id}/assignments`, { assignments: [{ petId: pets[2]!.id, resourceId: k1.id }] })).statusCode).toBe(200);
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${r1.id}`)).json().items;
    expect(audit.filter((a: { action: string }) => a.action === "reservation.resources_assigned")).toHaveLength(2);
  });

  it("rejects pets not on the reservation and resources from another organization", async () => {
    const r = (await book(boarding.id, [pets[3]!.id], at("2026-09-10", "14:00"), at("2026-09-11", "11:00"))).json();
    expect((await desk.put(`/api/reservations/${r.id}/assignments`, { assignments: [{ petId: pets[0]!.id, resourceId: k1.id }] })).statusCode).toBe(422);
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    const foreign = (await intruder.post("/api/resources", { locationId: other.locationId, name: "X", kind: "kennel", capacity: 1 })).json();
    expect((await desk.put(`/api/reservations/${r.id}/assignments`, { assignments: [{ petId: pets[3]!.id, resourceId: foreign.id }] })).statusCode).toBe(422);
    expect((await intruder.get(`/api/resources?locationId=${org.locationId}`)).json().items).toHaveLength(0);
    expect((await intruder.put(`/api/locations/${org.locationId}/capacity`, { daycare: 0, boarding: 0 })).statusCode).toBe(404);
    expect((await intruder.patch(`/api/resources/${k1.id}`, { capacity: 50 })).statusCode).toBe(404);
    expect((await intruder.put(`/api/reservations/${r.id}/assignments`, { assignments: [{ petId: pets[3]!.id, resourceId: foreign.id }] })).statusCode).toBe(404);
  });
});
