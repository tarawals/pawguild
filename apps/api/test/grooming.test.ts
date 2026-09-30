import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let groomer: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let groomId: string;
let boardingId: string;
let customerId: string;
const pets: string[] = [];
let groomerM: string;
let managerM: string;

const DAY = "2026-11-10"; // a Tuesday; New York is UTC-5
const at = (time: string, day = DAY) => `${day}T${time}:00-05:00`;
const book = (client: typeof desk, pet: number, from: string, to: string, extra: object = {}) =>
  client.post("/api/reservations", {
    customerId, locationId: org.locationId, serviceId: groomId, petIds: [pets[pet]], startsAt: at(from), endsAt: at(to), status: "confirmed", ...extra,
  });

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "groomer", "care_attendant"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  groomer = await login(ctx.app, org.users.groomer!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  groomId = (await manager.post("/api/services", { name: "Full Groom", category: "grooming", priceCents: 8500, priceUnit: "per_visit", durationMinutes: 90 })).json().id;
  boardingId = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json().id;
  customerId = (await desk.post("/api/customers", { firstName: "Gia", lastName: "Groom" })).json().id;
  for (const name of ["Ace", "Bo", "Cy", "Di", "Ed"]) pets.push((await desk.post("/api/pets", { customerId, name, species: "dog" })).json().id);
  const staff = (await groomer.get("/api/grooming/staff")).json().items;
  groomerM = staff.find((s: { role: string }) => s.role === "groomer").membershipId;
  managerM = staff.find((s: { role: string }) => s.role === "manager").membershipId;
});
afterAll(async () => { await ctx.close(); });

describe("assigning groomers when booking", () => {
  it("lists active staff with groomers first", async () => {
    const staff = (await care.get("/api/grooming/staff")).json().items;
    expect(staff[0]).toMatchObject({ role: "groomer", name: "groomer Tester" });
    expect(staff.map((s: { role: string }) => s.role).sort()).toEqual(["care_attendant", "front_desk", "groomer", "manager"]);
  });

  it("books a groomer, and won't double-book them", async () => {
    const first = await book(desk, 0, "10:00", "11:30", { groomerMembershipId: groomerM });
    expect(first.statusCode).toBe(201);
    expect(first.json().groomer).toEqual({ membershipId: groomerM, name: "groomer Tester" });
    const clash = await book(desk, 1, "11:00", "12:00", { groomerMembershipId: groomerM });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({ code: "groomer_double_booked",
      message: "groomer Tester already has a grooming appointment from 10:00 AM to 11:30 AM (Ace). Choose another time or groomer." });
    // Back to back is fine, and so is another groomer at the same time.
    expect((await book(desk, 1, "11:30", "13:00", { groomerMembershipId: groomerM })).statusCode).toBe(201);
    expect((await book(desk, 2, "11:00", "12:00", { groomerMembershipId: managerM })).statusCode).toBe(201);
    // Unassigned appointments don't clash with anyone.
    expect((await book(desk, 3, "10:00", "11:00")).json().groomer).toBeNull();
  });

  it("only grooming appointments get a groomer, and only active staff", async () => {
    const boarding = await desk.post("/api/reservations", {
      customerId, locationId: org.locationId, serviceId: boardingId, petIds: [pets[4]], startsAt: at("14:00", "2026-11-20"), endsAt: at("11:00", "2026-11-21"),
      groomerMembershipId: groomerM,
    });
    expect(boarding.statusCode).toBe(422);
    expect(boarding.json().error.message).toBe("A groomer can only be assigned to a grooming appointment.");
    expect((await book(desk, 4, "15:00", "16:00", { groomerMembershipId: "00000000-0000-4000-8000-000000000000" })).json().error.message)
      .toBe("That groomer was not found.");
  });

  it("rescheduling re-checks the groomer; unassigning is allowed", async () => {
    const r = (await book(desk, 4, "14:00", "15:00", { groomerMembershipId: groomerM })).json();
    const moved = await desk.patch(`/api/reservations/${r.id}`, { startsAt: at("12:30"), endsAt: at("13:30") });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.message).toMatch(/from 11:30 AM to 1:00 PM \(Bo\)/);
    expect((await desk.patch(`/api/reservations/${r.id}`, { notes: "Short cut" })).statusCode).toBe(200); // times unchanged: no re-check
    const cleared = await desk.patch(`/api/reservations/${r.id}`, { groomerMembershipId: null, startsAt: at("12:30"), endsAt: at("13:30") });
    expect(cleared.json()).toMatchObject({ groomer: null });
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${r.id}`)).json().items[0];
    expect(audit.changes.groomerMembershipId).toEqual({ from: groomerM, to: null });
  });
});

describe("the day's schedule", () => {
  it("shows the day's appointments by groomer, in the location's time zone", async () => {
    await book(desk, 0, "09:00", "10:00").then(async (r) => {
      // Cancelled appointments are left out.
      await desk.post(`/api/reservations/${r.json().id}/status`, { status: "cancelled", reason: "Sick" });
    });
    await book(desk, 0, "22:30", "23:30"); // late evening local time is still the same day
    await desk.post("/api/reservations", {
      customerId, locationId: org.locationId, serviceId: groomId, petIds: [pets[0]], startsAt: at("10:00", "2026-11-11"), endsAt: at("11:00", "2026-11-11"),
    });
    const s = (await care.get(`/api/grooming/schedule?date=${DAY}`)).json();
    expect(s).toMatchObject({ date: DAY, timeZone: "America/New_York", location: { id: org.locationId } });
    // Groomers always get a column; the manager has one because they have an appointment today.
    expect(s.groomers.map((g: { membershipId: string }) => g.membershipId)).toEqual([groomerM, managerM]);
    const summary = s.appointments.map((a: { startsAt: string; groomerMembershipId: string | null; pets: { name: string }[] }) =>
      [new Date(a.startsAt).toISOString(), a.groomerMembershipId === groomerM ? "groomer" : a.groomerMembershipId === managerM ? "manager" : null, a.pets.map((p) => p.name).join()]).sort((x: string[], y: string[]) => (x[0]! + x[2]).localeCompare(y[0]! + y[2]));
    expect(summary).toEqual([
      ["2026-11-10T15:00:00.000Z", "groomer", "Ace"],
      ["2026-11-10T15:00:00.000Z", null, "Di"],
      ["2026-11-10T16:00:00.000Z", "manager", "Cy"],
      ["2026-11-10T16:30:00.000Z", "groomer", "Bo"],
      ["2026-11-10T17:30:00.000Z", null, "Ed"],
      ["2026-11-11T03:30:00.000Z", null, "Ace"],
    ]);
    expect((await care.get(`/api/grooming/schedule?date=${DAY}&locationId=00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    expect((await care.get(`/api/grooming/schedule?date=tuesday`)).statusCode).toBe(400);
  });
});

describe("assigning from the schedule", () => {
  it("front desk and groomers can assign, care attendants can't; works after check-in, not after completion", async () => {
    const s = (await desk.get(`/api/grooming/schedule?date=${DAY}`)).json();
    const di = s.appointments.find((a: { pets: { name: string }[] }) => a.pets[0]?.name === "Di");
    expect((await care.put(`/api/grooming/appointments/${di.id}/groomer`, { membershipId: groomerM })).statusCode).toBe(403);
    // Di (10:00–11:00) clashes with Ace for the groomer, so the manager takes it.
    expect((await desk.put(`/api/grooming/appointments/${di.id}/groomer`, { membershipId: groomerM })).statusCode).toBe(409);
    await desk.post(`/api/reservations/${di.id}/status`, { status: "checked_in" });
    const ok = await groomer.put(`/api/grooming/appointments/${di.id}/groomer`, { membershipId: managerM });
    expect(ok.json()).toEqual({ groomerMembershipId: managerM });
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${di.id}`)).json().items[0];
    expect(audit).toMatchObject({ action: "reservation.groomer_assigned", changes: { groomerMembershipId: { from: null, to: managerM } } });
    await desk.post(`/api/reservations/${di.id}/status`, { status: "completed" });
    expect((await desk.put(`/api/grooming/appointments/${di.id}/groomer`, { membershipId: null })).statusCode).toBe(409);

    const boarding = (await desk.post("/api/reservations", {
      customerId, locationId: org.locationId, serviceId: boardingId, petIds: [pets[4]], startsAt: at("14:00", "2026-11-22"), endsAt: at("11:00", "2026-11-23"),
    })).json();
    expect((await desk.put(`/api/grooming/appointments/${boarding.id}/groomer`, { membershipId: groomerM })).statusCode).toBe(422);
  });

  it("deactivated staff can't be assigned, but stay visible on their appointments", async () => {
    await ctx.ownerDb.updateTable("memberships").set({ isActive: false }).where("id", "=", managerM).execute();
    const r = (await book(desk, 3, "16:00", "17:00")).json();
    const res = await desk.put(`/api/grooming/appointments/${r.id}/groomer`, { membershipId: managerM });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe("manager Tester is no longer active and can't be assigned.");
    const s = (await desk.get(`/api/grooming/schedule?date=${DAY}`)).json();
    expect(s.groomers.map((g: { name: string }) => g.name)).toEqual(["groomer Tester", "manager Tester (inactive)"]);
    expect((await desk.get("/api/grooming/staff")).json().items.map((x: { membershipId: string }) => x.membershipId)).not.toContain(managerM);
    await ctx.ownerDb.updateTable("memberships").set({ isActive: true }).where("id", "=", managerM).execute();
  });

  it("two simultaneous bookings for the same groomer: exactly one wins", async () => {
    const day = "2026-11-12";
    const race = await Promise.all([0, 1, 2].map((p) => desk.post("/api/reservations", {
      customerId, locationId: org.locationId, serviceId: groomId, petIds: [pets[p]], startsAt: at("13:00", day), endsAt: at("14:00", day),
      groomerMembershipId: groomerM,
    })));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
  });
});

describe("tenant isolation", () => {
  it("other organizations can't see, use or change our groomers and appointments", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get("/api/grooming/staff")).json().items.map((s: { membershipId: string }) => s.membershipId)).not.toContain(groomerM);
    expect((await outsider.get(`/api/grooming/schedule?date=${DAY}`)).json().appointments).toEqual([]);
    expect((await outsider.get(`/api/grooming/schedule?date=${DAY}&locationId=${org.locationId}`)).statusCode).toBe(404);
    const theirGroom = (await outsider.post("/api/services", { name: "Groom", category: "grooming", priceCents: 1000, priceUnit: "per_visit" })).json();
    const theirCustomer = (await outsider.post("/api/customers", { firstName: "O", lastName: "T" })).json();
    const theirPet = (await outsider.post("/api/pets", { customerId: theirCustomer.id, name: "Zed", species: "dog" })).json();
    const usingOurs = await outsider.post("/api/reservations", {
      customerId: theirCustomer.id, locationId: other.locationId, serviceId: theirGroom.id, petIds: [theirPet.id],
      startsAt: at("10:00"), endsAt: at("11:00"), groomerMembershipId: groomerM,
    });
    expect(usingOurs.statusCode).toBe(422);
    const ours = (await desk.get(`/api/grooming/schedule?date=${DAY}`)).json().appointments[0];
    expect((await outsider.put(`/api/grooming/appointments/${ours.id}/groomer`, { membershipId: null })).statusCode).toBe(404);
  });
});
