import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, PASSWORD, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof login>>;
let gm: Awaited<ReturnType<typeof login>>;
let lm: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
const TEMP = "Temp-Passw0rd!";
let n = 0;
const newStaff = (role: string, extra: Record<string, unknown> = {}) =>
  ({ firstName: "New", lastName: `Person${++n}`, email: `new${n}-${Date.now()}@example.test`, role, temporaryPassword: TEMP, ...extra });
const signIn = (email: string, password: string) =>
  ctx.app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-pawguild-request": "1" }, payload: { email, password } });

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "general_manager", "location_manager", "manager", "front_desk"]);
  owner = await login(ctx.app, org.users.owner!.email);
  gm = await login(ctx.app, org.users.general_manager!.email);
  lm = await login(ctx.app, org.users.location_manager!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
});
afterAll(async () => { await ctx.close(); });

describe("adding staff", () => {
  it("creates a staff member with locations, who must change the temporary password first", async () => {
    const body = newStaff("front_desk", { locationIds: [org.locationId], jobTitle: "Weekend desk", phone: "555-0101" });
    const res = await gm.post("/api/employees", body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: "front_desk", jobTitle: "Weekend desk", locationIds: [org.locationId], mustChangePassword: true, isActive: true });
    expect(JSON.stringify(res.json())).not.toMatch(/passwordHash|scrypt/);

    const first = await signIn(body.email, TEMP);
    expect(first.statusCode).toBe(200);
    const cookie = `pawguild_session=${first.cookies.find((c) => c.name === "pawguild_session")!.value}`;
    const call = (method: "GET" | "POST", url: string, payload?: object) =>
      ctx.app.inject({ method, url, headers: { cookie, "x-pawguild-request": "1" }, ...(payload && { payload }) });
    expect((await call("GET", "/api/auth/me")).json().user.mustChangePassword).toBe(true);
    const blocked = await call("GET", "/api/customers");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe("password_change_required");

    expect((await call("POST", "/api/auth/change-password", { currentPassword: "wrong", newPassword: "Brand-new-pass-1" })).json().error.fields[0].path).toBe("currentPassword");
    expect((await call("POST", "/api/auth/change-password", { currentPassword: TEMP, newPassword: "short" })).statusCode).toBe(400);
    expect((await call("POST", "/api/auth/change-password", { currentPassword: TEMP, newPassword: TEMP })).statusCode).toBe(400);
    expect((await call("POST", "/api/auth/change-password", { currentPassword: TEMP, newPassword: "Brand-new-pass-1" })).statusCode).toBe(200);
    expect((await call("GET", "/api/customers")).statusCode).toBe(200);
    expect((await signIn(body.email, TEMP)).statusCode).toBe(401);
    expect((await signIn(body.email, "Brand-new-pass-1")).statusCode).toBe(200);
  });

  it("refuses duplicate emails, weak or email-as-password temporary passwords", async () => {
    expect((await owner.post("/api/employees", newStaff("employee", { email: org.users.front_desk!.email }))).json().error.fields[0].path).toBe("email");
    expect((await owner.post("/api/employees", newStaff("employee", { temporaryPassword: "short" }))).statusCode).toBe(400);
    const e = `same-${Date.now()}@example.test`;
    expect((await owner.post("/api/employees", newStaff("employee", { email: e, temporaryPassword: e }))).statusCode).toBe(400);
  });

  it("never lets anyone grant a role at or above their own", async () => {
    expect((await desk.post("/api/employees", newStaff("employee"))).statusCode).toBe(403);     // no employees:manage
    expect((await manager.post("/api/employees", newStaff("employee"))).statusCode).toBe(403);  // no employees:manage
    expect((await lm.post("/api/employees", newStaff("location_manager"))).statusCode).toBe(403);
    expect((await lm.post("/api/employees", newStaff("general_manager"))).statusCode).toBe(403);
    expect((await gm.post("/api/employees", newStaff("owner"))).statusCode).toBe(403);
    expect((await gm.post("/api/employees", newStaff("administrator"))).statusCode).toBe(403);
    expect((await lm.post("/api/employees", newStaff("manager"))).statusCode).toBe(201);
    expect((await owner.post("/api/employees", newStaff("owner"))).statusCode).toBe(201);
  });
});

describe("changing staff", () => {
  const idOf = async (email: string) => (await owner.get("/api/employees")).json().items.find((e: { email: string }) => e.email === email).id as string;

  it("can't promote someone above yourself or change people senior to you", async () => {
    const deskId = await idOf(org.users.front_desk!.email);
    expect((await lm.patch(`/api/employees/${deskId}`, { role: "general_manager" })).statusCode).toBe(403);
    expect((await lm.patch(`/api/employees/${deskId}`, { role: "shift_lead", jobTitle: "Lead" })).json()).toMatchObject({ role: "shift_lead", jobTitle: "Lead" });
    const gmId = await idOf(org.users.general_manager!.email);
    expect((await lm.patch(`/api/employees/${gmId}`, { phone: "1" })).statusCode).toBe(403);
    expect((await lm.post(`/api/employees/${gmId}/deactivate`)).statusCode).toBe(403);
    expect((await lm.post(`/api/employees/${gmId}/reset-password`, { temporaryPassword: TEMP })).statusCode).toBe(403);
    const list = (await lm.get("/api/employees")).json().items;
    expect(list.find((e: { id: string }) => e.id === gmId).canManage).toBe(false);
    expect(list.find((e: { id: string }) => e.id === deskId).canManage).toBe(true);
    await owner.patch(`/api/employees/${deskId}`, { role: "front_desk" });
  });

  it("can't change your own role or deactivate yourself, and the last owner stays", async () => {
    const gmId = await idOf(org.users.general_manager!.email);
    expect((await gm.patch(`/api/employees/${gmId}`, { role: "employee" })).statusCode).toBe(403);
    expect((await gm.post(`/api/employees/${gmId}/deactivate`)).statusCode).toBe(403);
    expect((await gm.patch(`/api/employees/${gmId}`, { phone: "555-0999" })).json().phone).toBe("555-0999"); // own contact details are fine

    const solo = await createOrg(ctx.ownerDb, ["owner"]);
    const soloOwner = await login(ctx.app, solo.users.owner!.email);
    const second = (await soloOwner.post("/api/employees", newStaff("owner"))).json();
    const soloId = (await soloOwner.get("/api/employees")).json().items.find((e: { email: string }) => e.email === solo.users.owner!.email).id;
    // Two owners: the other owner may demote this one; afterwards the remaining owner can't be removed.
    const otherOwnerRes = await signIn(second.email, TEMP);
    const cookie = `pawguild_session=${otherOwnerRes.cookies.find((c) => c.name === "pawguild_session")!.value}`;
    await ctx.app.inject({ method: "POST", url: "/api/auth/change-password", headers: { cookie, "x-pawguild-request": "1" }, payload: { currentPassword: TEMP, newPassword: "Owner-two-pass-1" } });
    const demote = await ctx.app.inject({ method: "PATCH", url: `/api/employees/${soloId}`, headers: { cookie, "x-pawguild-request": "1" }, payload: { role: "manager" } });
    expect(demote.statusCode).toBe(200);
    const lastOwner = await ctx.app.inject({ method: "POST", url: `/api/employees/${second.id}/deactivate`, headers: { cookie, "x-pawguild-request": "1" } });
    expect(lastOwner.statusCode).toBe(403); // can't deactivate yourself
  });

  it("deactivating signs the person out everywhere and blocks sign-in; reactivating restores access", async () => {
    const body = newStaff("care_attendant");
    const created = (await owner.post("/api/employees", body)).json();
    const s = await signIn(body.email, TEMP);
    const cookie = `pawguild_session=${s.cookies.find((c) => c.name === "pawguild_session")!.value}`;
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
    expect((await owner.post(`/api/employees/${created.id}/deactivate`)).json().isActive).toBe(false);
    expect((await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await signIn(body.email, TEMP)).statusCode).toBe(403);
    await owner.post(`/api/employees/${created.id}/reactivate`);
    expect((await signIn(body.email, TEMP)).statusCode).toBe(200);
    const audit = (await owner.get(`/api/audit?entityType=employee&entityId=${created.id}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(["employee.reactivated", "employee.deactivated", "employee.created"]);
  });

  it("password reset forces a change, signs them out and clears a sign-in lockout", async () => {
    const deskId = await idOf(org.users.front_desk!.email);
    for (let i = 0; i < 5; i++) await signIn(org.users.front_desk!.email, "wrong");
    expect((await signIn(org.users.front_desk!.email, PASSWORD)).statusCode).toBe(429);
    const res = await gm.post(`/api/employees/${deskId}/reset-password`, { temporaryPassword: TEMP });
    expect(res.json().mustChangePassword).toBe(true);
    expect((await desk.get("/api/auth/me")).statusCode).toBe(401); // old session ended
    expect((await signIn(org.users.front_desk!.email, TEMP)).statusCode).toBe(200);
    expect(JSON.stringify((await owner.get(`/api/audit?entityId=${deskId}`)).json())).not.toContain(TEMP);
  });
});

describe("staff privacy", () => {
  it("only lists this organization's staff and can't touch other organizations' staff", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner", "front_desk"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    const mine = (await owner.get("/api/employees")).json().items;
    const theirs = (await intruder.get("/api/employees")).json().items;
    expect(theirs.map((e: { email: string }) => e.email).sort()).toEqual([other.users.owner!.email, other.users.front_desk!.email].sort());
    const target = mine[0].id;
    expect((await intruder.patch(`/api/employees/${target}`, { phone: "x" })).statusCode).toBe(404);
    expect((await intruder.post(`/api/employees/${target}/deactivate`)).statusCode).toBe(404);
    expect((await intruder.post(`/api/employees/${target}/reset-password`, { temporaryPassword: TEMP })).statusCode).toBe(404);
    expect((await intruder.post("/api/employees", newStaff("employee", { locationIds: [org.locationId] }))).statusCode).toBe(400);
  });
});
