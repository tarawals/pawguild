import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let gm: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let customerId: string;
let petIds: string[];
let serviceId: string;

// America/New_York; December dates are UTC-5. 2026-12-07 is a Monday, 2026-12-06 a Sunday.
const at = (local: string) => `${local}:00-05:00`;
const WEEK = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensAt: "07:00", closesAt: "19:00" }))
  .concat([{ weekday: 6, opensAt: "08:00", closesAt: "17:00" }]);

async function book(client = desk, startsAt: string, endsAt: string, extra: object = {}, pet = 0) {
  return client.post("/api/reservations", {
    customerId, locationId: org.locationId, serviceId, petIds: [petIds[pet]], startsAt: at(startsAt), endsAt: at(endsAt), status: "confirmed", ...extra,
  });
}

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["general_manager", "manager", "front_desk"]);
  gm = await login(ctx.app, org.users.general_manager!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  serviceId = (await gm.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json().id;
  customerId = (await desk.post("/api/customers", { firstName: "Hana", lastName: "Hours" })).json().id;
  petIds = [];
  for (const name of ["Ace", "Bea", "Cy", "Dot"]) petIds.push((await desk.post("/api/pets", { customerId, name, species: "dog" })).json().id);
});
afterAll(async () => { await ctx.close(); });

describe("location details", () => {
  it("lists locations with hours, closures and the effective time zone", async () => {
    const [loc] = (await desk.get("/api/locations")).json().items;
    expect(loc).toMatchObject({ id: org.locationId, name: "Main", timezone: null, effectiveTimezone: "America/New_York", hours: [], closures: [], isActive: true });
  });

  it("general managers add and edit locations; managers can't", async () => {
    expect((await manager.post("/api/locations", { name: "Uptown" })).statusCode).toBe(403);
    expect((await manager.patch(`/api/locations/${org.locationId}`, { name: "X" })).statusCode).toBe(403);
    const bad = await gm.post("/api/locations", { name: "", timezone: "Mars/Olympus", country: "USA", email: "nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["country", "email", "name", "timezone"]);
    expect((await gm.post("/api/locations", { name: "main" })).json().error.fields[0]).toMatchObject({ path: "name", message: "Another location already has this name" });

    const created = await gm.post("/api/locations", { name: "Uptown", city: "Portland", country: "us", timezone: "America/Chicago", phone: "555-0101" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: "Uptown", country: "US", timezone: "America/Chicago", effectiveTimezone: "America/Chicago", isActive: true });
    const edited = await gm.patch(`/api/locations/${created.json().id}`, { name: "Uptown Resort", timezone: "" });
    expect(edited.json()).toMatchObject({ name: "Uptown Resort", timezone: null, effectiveTimezone: "America/New_York", city: "Portland" });
    expect((await gm.patch(`/api/locations/${created.json().id}`, {})).statusCode).toBe(200);
    const audit = (await gm.get(`/api/audit?entityType=location&entityId=${created.json().id}`)).json().items;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(["location.updated", "location.created"]);
    expect(audit[0].changes).toMatchObject({ name: { from: "Uptown", to: "Uptown Resort" }, timezone: { from: "America/Chicago", to: null } });
  });

  it("won't deactivate a location with upcoming stays, or the last active one", async () => {
    const uptown = (await gm.get("/api/locations")).json().items.find((l: { name: string }) => l.name === "Uptown Resort");
    const r = (await desk.post("/api/reservations", {
      customerId, locationId: uptown.id, serviceId, petIds: [petIds[3]],
      startsAt: at("2027-03-01T10:00"), endsAt: at("2027-03-02T10:00"), status: "confirmed",
    })).json();
    const blocked = await gm.patch(`/api/locations/${uptown.id}`, { isActive: false });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toMatch(/1 upcoming or current reservation\./);
    await desk.post(`/api/reservations/${r.id}/status`, { status: "cancelled", reason: "Moved" });
    expect((await gm.patch(`/api/locations/${uptown.id}`, { isActive: false })).json().isActive).toBe(false);
    expect((await desk.get("/api/locations")).json().items.map((l: { id: string }) => l.id)).toEqual([org.locationId]);
    expect((await desk.get("/api/locations?includeInactive=true")).json().items).toHaveLength(2);
    // Inactive locations can't take bookings.
    expect((await desk.post("/api/reservations", {
      customerId, locationId: uptown.id, serviceId, petIds: [petIds[3]], startsAt: at("2027-03-05T10:00"), endsAt: at("2027-03-06T10:00"),
    })).statusCode).toBe(422);
    const last = await gm.patch(`/api/locations/${org.locationId}`, { isActive: false });
    expect(last.json().error.code).toBe("last_location");
    expect((await gm.patch(`/api/locations/${uptown.id}`, { isActive: true })).json().isActive).toBe(true);
    const actions = (await gm.get(`/api/audit?entityType=location&entityId=${uptown.id}`)).json().items.map((a: { action: string }) => a.action);
    expect(actions.slice(0, 2)).toEqual(["location.reactivated", "location.deactivated"]);
  });
});

describe("business hours", () => {
  it("validates and replaces the week", async () => {
    expect((await manager.put(`/api/locations/${org.locationId}/hours`, { days: WEEK })).statusCode).toBe(403);
    const bad = await gm.put(`/api/locations/${org.locationId}/hours`, {
      days: [{ weekday: 1, opensAt: "19:00", closesAt: "07:00" }, { weekday: 1, opensAt: "07:00", closesAt: "8pm" }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields.map((f: { path: string }) => f.path).sort()).toEqual(["days.0.closesAt", "days.1.closesAt", "days.1.weekday"]);
    const ok = await gm.put(`/api/locations/${org.locationId}/hours`, { days: [...WEEK].reverse() });
    expect(ok.json().hours).toEqual(WEEK);
    expect((await desk.get("/api/locations")).json().items[0].hours).toEqual(WEEK);
    await gm.put(`/api/locations/${org.locationId}/hours`, { days: WEEK }); // unchanged: no second audit entry
    const audit = (await gm.get(`/api/audit?entityType=location&entityId=${org.locationId}`)).json().items;
    expect(audit.filter((a: { action: string }) => a.action === "location.hours_updated")).toHaveLength(1);
  });

  it("refuses drop-off or pick-up outside hours or on a closed weekday", async () => {
    const early = await book(desk, "2026-12-07T06:30", "2026-12-08T10:00");
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toMatchObject({ code: "outside_hours" });
    expect(early.json().error.message).toContain("Drop-off on Mon, Dec 7 at 6:30 AM is before opening (open 7:00 AM–7:00 PM)");
    const sunday = await book(desk, "2026-12-04T10:00", "2026-12-06T10:00");
    expect(sunday.json().error.message).toContain("Pick-up on Sun, Dec 6 at 10:00 AM: the location is closed on Sundays");
    const late = await book(desk, "2026-12-05T17:30", "2026-12-07T10:00");
    expect(late.json().error.message).toContain("after closing (open 8:00 AM–5:00 PM)");
    // Opening and closing times themselves are fine, and a stay may span a closed Sunday.
    expect((await book(desk, "2026-12-05T08:00", "2026-12-07T19:00")).statusCode).toBe(201);
  });

  it("managers can book outside hours with an audited override; front desk can't", async () => {
    expect((await book(desk, "2026-12-08T06:00", "2026-12-09T10:00", { overrideHours: true }, 1)).statusCode).toBe(403);
    const res = await book(manager, "2026-12-08T06:00", "2026-12-09T10:00", { overrideHours: true }, 1);
    expect(res.statusCode).toBe(201);
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${res.json().id}`)).json().items[0];
    expect(audit.changes.hoursOverride).toEqual(["Drop-off on Tue, Dec 8 at 6:00 AM is before opening (open 7:00 AM–7:00 PM)"]);
  });

  it("a reschedule checks only the end that moved", async () => {
    const r = (await book(manager, "2026-12-14T06:00", "2026-12-15T10:00", { overrideHours: true }, 2)).json();
    // Moving only the pick-up doesn't re-check the (overridden) drop-off.
    const moved = await desk.patch(`/api/reservations/${r.id}`, { endsAt: at("2026-12-16T11:00") });
    expect(moved.statusCode).toBe(200);
    expect((await desk.patch(`/api/reservations/${r.id}`, { notes: "Bring blanket" })).statusCode).toBe(200);
    const bad = await desk.patch(`/api/reservations/${r.id}`, { endsAt: at("2026-12-16T20:00") });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.message).toMatch(/^Pick-up on Wed, Dec 16 at 8:00 PM is after closing/);
  });

  it("an empty week removes the restriction", async () => {
    await gm.put(`/api/locations/${org.locationId}/hours`, { days: [] });
    expect((await book(desk, "2026-12-20T05:00", "2026-12-21T23:00", {}, 3)).statusCode).toBe(201);
    await gm.put(`/api/locations/${org.locationId}/hours`, { days: WEEK });
  });
});

describe("closures", () => {
  it("adds and removes closure dates, reporting bookings on that day", async () => {
    expect((await manager.post(`/api/locations/${org.locationId}/closures`, { closedOn: "2026-12-16" })).statusCode).toBe(403);
    expect((await gm.post(`/api/locations/${org.locationId}/closures`, { closedOn: "Dec 16" })).statusCode).toBe(400);
    const added = await gm.post(`/api/locations/${org.locationId}/closures`, { closedOn: "2026-12-16", reason: "Staff training" });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ closedOn: "2026-12-16", reason: "Staff training", affectedReservations: 1 });
    expect((await gm.post(`/api/locations/${org.locationId}/closures`, { closedOn: "2026-12-16" })).json().error.fields[0].message)
      .toBe("That day is already marked as closed");
    await gm.post(`/api/locations/${org.locationId}/closures`, { closedOn: "2026-12-25", reason: "Christmas" });
    const loc = (await desk.get("/api/locations")).json().items[0];
    expect(loc.closures.map((c: { closedOn: string }) => c.closedOn)).toEqual(["2026-12-16", "2026-12-25"]);

    const xmas = await book(desk, "2026-12-24T10:00", "2026-12-25T10:00", {}, 3);
    expect(xmas.json().error.message).toContain("Pick-up on Fri, Dec 25 at 10:00 AM: the location is closed that day (Christmas)");

    expect((await manager.delete(`/api/locations/${org.locationId}/closures/${added.json().id}`)).statusCode).toBe(403);
    expect((await gm.delete(`/api/locations/${org.locationId}/closures/${added.json().id}`)).statusCode).toBe(200);
    expect((await gm.delete(`/api/locations/${org.locationId}/closures/${added.json().id}`)).statusCode).toBe(404);
    const actions = (await gm.get(`/api/audit?entityType=location&entityId=${org.locationId}`)).json().items.map((a: { action: string }) => a.action);
    expect(actions.slice(0, 3)).toEqual(["location.closure_removed", "location.closure_added", "location.closure_added"]);
  });
});

describe("tenant isolation", () => {
  it("another organization can't see or change our locations", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get("/api/locations?includeInactive=true")).json().items.map((l: { id: string }) => l.id)).toEqual([other.locationId]);
    expect((await outsider.patch(`/api/locations/${org.locationId}`, { name: "Hijacked" })).statusCode).toBe(404);
    expect((await outsider.put(`/api/locations/${org.locationId}/hours`, { days: [] })).statusCode).toBe(404);
    expect((await outsider.post(`/api/locations/${org.locationId}/closures`, { closedOn: "2026-12-31" })).statusCode).toBe(404);
    const closure = (await desk.get("/api/locations")).json().items[0].closures[0];
    expect((await outsider.delete(`/api/locations/${other.locationId}/closures/${closure.id}`)).statusCode).toBe(404);
    expect((await desk.get("/api/locations")).json().items[0]).toMatchObject({ name: "Main", hours: WEEK });
    // Our name doesn't block theirs.
    expect((await outsider.post("/api/locations", { name: "Uptown Resort" })).statusCode).toBe(201);
  });
});
