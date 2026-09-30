import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let groomer: Awaited<ReturnType<typeof login>>;
const m: Record<string, string> = {};

// New York: UTC-5 until 2027-03-14, UTC-4 after.
const est = (d: string, t: string) => `${d}T${t}:00-05:00`;
const shift = (who: string, d: string, from: string, to: string, extra: object = {}) =>
  manager.post("/api/shifts", { locationId: org.locationId, membershipId: m[who], startsAt: est(d, from), endsAt: est(d, to), ...extra });

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "groomer", "care_attendant"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  groomer = await login(ctx.app, org.users.groomer!.email);
  for (const s of (await manager.get("/api/grooming/staff")).json().items) m[s.role] = s.membershipId;
  await ctx.ownerDb.insertInto("locationHours").values([1, 2, 3, 4, 5].map((weekday) => ({
    organizationId: org.orgId, locationId: org.locationId, weekday, opensAt: "07:00", closesAt: "19:00",
  }))).execute();
});
afterAll(async () => { await ctx.close(); });

describe("creating shifts", () => {
  it("managers schedule staff; shifts outside hours are allowed but flagged", async () => {
    expect((await desk.post("/api/shifts", { locationId: org.locationId, membershipId: m.front_desk, startsAt: est("2026-12-07", "08:00"), endsAt: est("2026-12-07", "16:00") })).statusCode).toBe(403);
    const res = await shift("front_desk", "2026-12-07", "06:30", "14:30", { note: "Opening" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      staffName: "front_desk Tester", role: "front_desk", locationName: "Main", date: "2026-12-07", note: "Opening",
      warnings: ["Start on Mon, Dec 7 at 6:30 AM is before opening (open 7:00 AM–7:00 PM)"],
    });
    expect((await shift("groomer", "2026-12-07", "09:00", "17:00")).json().warnings).toEqual([]);
    const audit = (await manager.get(`/api/audit?entityType=shift&entityId=${res.json().id}`)).json().items[0];
    expect(audit).toMatchObject({ action: "shift.created", changes: { membershipId: m.front_desk, note: "Opening" } });
  });

  it("won't double-book a person; back to back is fine", async () => {
    const clash = await shift("front_desk", "2026-12-07", "14:00", "20:00");
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message).toBe("front_desk Tester is already scheduled 6:30 AM–2:30 PM on Mon, Dec 7 at Main.");
    const next = await shift("front_desk", "2026-12-07", "14:30", "19:30");
    expect(next.statusCode).toBe(201);
    expect(next.json().warnings[0]).toMatch(/^End on Mon, Dec 7 at 7:30 PM is after closing/);
  });

  it("validates length, staff and location", async () => {
    const tooLong = await manager.post("/api/shifts", { locationId: org.locationId, membershipId: m.care_attendant, startsAt: est("2026-12-08", "05:00"), endsAt: est("2026-12-08", "22:00") });
    expect(tooLong.json().error.fields[0]).toEqual({ path: "endsAt", message: "A shift can be at most 16 hours" });
    expect((await shift("care_attendant", "2026-12-08", "10:00", "09:00")).json().error.fields[0].message).toBe("The shift must end after it starts");
    const nobody = await manager.post("/api/shifts", { locationId: org.locationId, membershipId: "00000000-0000-4000-8000-000000000000", startsAt: est("2026-12-08", "09:00"), endsAt: est("2026-12-08", "10:00") });
    expect(nobody.json().error.fields[0]).toEqual({ path: "membershipId", message: "Choose a staff member" });
    // Overnight shifts cross midnight and belong to the day they start.
    const night = await manager.post("/api/shifts", { locationId: org.locationId, membershipId: m.care_attendant, startsAt: est("2026-12-08", "22:00"), endsAt: est("2026-12-09", "06:00") });
    expect(night.json()).toMatchObject({ date: "2026-12-08" });
  });
});

describe("the schedule", () => {
  it("anyone signed in can view it, filtered by local date, location and person", async () => {
    const week = (await groomer.get("/api/shifts?from=2026-12-07&to=2026-12-13")).json().items;
    expect(week.map((s: { staffName: string; date: string }) => `${s.date} ${s.staffName}`)).toEqual([
      "2026-12-07 front_desk Tester", "2026-12-07 groomer Tester", "2026-12-07 front_desk Tester", "2026-12-08 care_attendant Tester",
    ]);
    expect((await groomer.get("/api/shifts?from=2026-12-09&to=2026-12-09")).json().items).toEqual([]); // the overnight shift started the 8th
    expect((await groomer.get(`/api/shifts?from=2026-12-07&to=2026-12-13&membershipId=${m.groomer}`)).json().items).toHaveLength(1);
    expect((await groomer.get("/api/shifts?from=2026-12-01&to=2027-02-01")).statusCode).toBe(400);
  });

  it("edits are re-checked and audited; deleting keeps the record in the audit log", async () => {
    const [first] = (await manager.get(`/api/shifts?from=2026-12-07&to=2026-12-07&membershipId=${m.groomer}`)).json().items;
    expect((await desk.patch(`/api/shifts/${first.id}`, { note: "x" })).statusCode).toBe(403);
    expect((await manager.patch(`/api/shifts/${first.id}`, { membershipId: m.front_desk })).statusCode).toBe(409);
    const edited = await manager.patch(`/api/shifts/${first.id}`, { note: "Bath day", endsAt: est("2026-12-07", "18:00") });
    expect(edited.json()).toMatchObject({ note: "Bath day" });
    expect((await manager.patch(`/api/shifts/${first.id}`, {})).statusCode).toBe(200);
    const audit = (await manager.get(`/api/audit?entityType=shift&entityId=${first.id}`)).json().items;
    expect(audit.map((a: { action: string }) => a.action)).toEqual(["shift.updated", "shift.created"]);
    expect(Object.keys(audit[0].changes).sort()).toEqual(["endsAt", "note"]);

    expect((await desk.delete(`/api/shifts/${first.id}`)).statusCode).toBe(403);
    expect((await manager.delete(`/api/shifts/${first.id}`)).statusCode).toBe(200);
    expect((await manager.delete(`/api/shifts/${first.id}`)).statusCode).toBe(404);
    const gone = (await manager.get(`/api/audit?entityType=shift&entityId=${first.id}`)).json().items[0];
    expect(gone).toMatchObject({ action: "shift.deleted", changes: { membershipId: m.groomer, note: "Bath day" } });
  });
});

describe("copying a week", () => {
  it("keeps local times across DST and skips shifts that would clash", async () => {
    // Week of Mon 2027-03-08 (EST); DST starts Sun 2027-03-14, so the next week is EDT.
    await shift("groomer", "2027-03-08", "09:00", "17:00");
    await shift("front_desk", "2027-03-09", "07:00", "15:00", { note: "Opening" });
    await shift("care_attendant", "2027-03-10", "10:00", "18:00");
    // Already booked in the target week: the desk shift will be skipped.
    await manager.post("/api/shifts", { locationId: org.locationId, membershipId: m.front_desk, startsAt: "2027-03-16T12:00:00-04:00", endsAt: "2027-03-16T20:00:00-04:00" });
    const res = await manager.post("/api/shifts/copy-week", { locationId: org.locationId, fromWeekStart: "2027-03-08", toWeekStart: "2027-03-15" });
    expect(res.json()).toEqual({
      created: 2,
      skipped: [{ staffName: "front_desk Tester", date: "2027-03-16", reason: "front_desk Tester is already scheduled 12:00 PM–8:00 PM on Tue, Mar 16 at Main." }],
    });
    const copied = (await manager.get("/api/shifts?from=2027-03-15&to=2027-03-21")).json().items;
    const groomerShift = copied.find((s: { membershipId: string }) => s.membershipId === m.groomer);
    expect(groomerShift).toMatchObject({ date: "2027-03-15", startsAt: "2027-03-15T13:00:00.000Z", endsAt: "2027-03-15T21:00:00.000Z" });
    // Copying again creates nothing new.
    const again = (await manager.post("/api/shifts/copy-week", { locationId: org.locationId, fromWeekStart: "2027-03-08", toWeekStart: "2027-03-15" })).json();
    expect(again.created).toBe(0);
    expect(again.skipped).toHaveLength(3);
    expect((await desk.post("/api/shifts/copy-week", { locationId: org.locationId, fromWeekStart: "2027-03-08", toWeekStart: "2027-03-22" })).statusCode).toBe(403);
  });

  it("two simultaneous overlapping shifts for one person: exactly one wins", async () => {
    const race = await Promise.all([0, 1, 2].map((i) => shift("groomer", "2027-04-05", `${String(8 + i).padStart(2, "0")}:00`, `${12 + i}:00`)));
    expect(race.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
  });
});

describe("where shifts show up", () => {
  it("the dashboard lists who's working today, and the grooming schedule shows each groomer's hours", async () => {
    const now = Date.now();
    const s = (await manager.post("/api/shifts", {
      locationId: org.locationId, membershipId: m.groomer, startsAt: new Date(now - 3600_000).toISOString(), endsAt: new Date(now + 3600_000).toISOString(),
    })).json();
    const dash = (await desk.get("/api/dashboard/summary")).json();
    expect(dash.workingToday.map((w: { id: string }) => w.id)).toContain(s.id);
    expect(dash.workingToday.find((w: { id: string }) => w.id === s.id)).toMatchObject({ staffName: "groomer Tester", locationName: "Main" });
    const grooming = (await groomer.get(`/api/grooming/schedule?date=${s.date}`)).json();
    expect(grooming.groomers[0].shifts).toContainEqual({ startsAt: s.startsAt, endsAt: s.endsAt });
  });
});

describe("tenant isolation", () => {
  it("other organizations can't see or touch our schedule or schedule our staff", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get("/api/shifts?from=2026-12-01&to=2026-12-31")).json().items).toEqual([]);
    const ours = (await manager.get("/api/shifts?from=2026-12-07&to=2026-12-13")).json().items[0];
    expect((await outsider.patch(`/api/shifts/${ours.id}`, { note: "x" })).statusCode).toBe(404);
    expect((await outsider.delete(`/api/shifts/${ours.id}`)).statusCode).toBe(404);
    const useOurStaff = await outsider.post("/api/shifts", { locationId: other.locationId, membershipId: m.groomer, startsAt: est("2026-12-20", "09:00"), endsAt: est("2026-12-20", "10:00") });
    expect(useOurStaff.json().error.fields[0].path).toBe("membershipId");
    const theirs = (await outsider.get("/api/grooming/staff")).json().items[0].membershipId;
    const useOurLocation = await outsider.post("/api/shifts", { locationId: org.locationId, membershipId: theirs, startsAt: est("2026-12-20", "09:00"), endsAt: est("2026-12-20", "10:00") });
    expect(useOurLocation.json().error.fields[0].path).toBe("locationId");
    expect((await outsider.post("/api/shifts/copy-week", { locationId: org.locationId, fromWeekStart: "2026-12-07", toWeekStart: "2026-12-14" })).statusCode).toBe(404);
  });
});
