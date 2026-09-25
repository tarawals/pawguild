import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let employee: Awaited<ReturnType<typeof login>>;
let stay: { id: string };
let rex: { id: string };
let luna: { id: string };
let customer: { id: string };
let tz: string;

/** Local "HH:MM" in the org's time zone, offset by minutes from now. */
const localTime = (offsetMin: number) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(Date.now() + offsetMin * 60_000));

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant", "employee"]);
  // Use a fixed-offset zone where it is currently about noon, so "2 hours ago" and "in 1 hour"
  // are always the same local day regardless of when the suite runs.
  const x = new Date().getUTCHours() - 12;
  tz = `Etc/GMT${x >= 0 ? "+" : "-"}${Math.abs(x)}`;
  await ctx.ownerDb.updateTable("organizations").set({ timezone: tz }).where("id", "=", org.orgId).execute();

  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  employee = await login(ctx.app, org.users.employee!.email);
  const boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json();
  customer = (await desk.post("/api/customers", { firstName: "Care", lastName: "Test" })).json();
  rex = (await desk.post("/api/pets", { customerId: customer.id, name: "Rex", species: "dog" })).json();
  luna = (await desk.post("/api/pets", { customerId: customer.id, name: "Luna", species: "dog" })).json();
  stay = (await desk.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [rex.id],
    startsAt: new Date(Date.now() - 6 * 3600_000).toISOString(), endsAt: new Date(Date.now() + 30 * 3600_000).toISOString(), status: "confirmed",
  })).json();
  await desk.post(`/api/reservations/${stay.id}/status`, { status: "checked_in" });
});
afterAll(async () => { await ctx.close(); });

describe("pet medications", () => {
  let medId: string;
  it("records standing orders with normalized times; discontinuing keeps history", async () => {
    const bad = await desk.post(`/api/pets/${rex.id}/medications`, { name: "Apoquel", dosage: "16mg", times: ["8am"] });
    expect(bad.statusCode).toBe(400);
    const created = await desk.post(`/api/pets/${rex.id}/medications`, {
      name: "Apoquel", dosage: "16 mg tablet", instructions: "With food", times: [localTime(60), localTime(-120)],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().times).toEqual([localTime(-120), localTime(60)]);
    medId = created.json().id;

    const temp = (await desk.post(`/api/pets/${rex.id}/medications`, { name: "Old med", dosage: "1ml", times: [] })).json();
    expect((await desk.post(`/api/pets/${rex.id}/medications/${temp.id}/discontinue`)).statusCode).toBe(200);
    expect((await desk.post(`/api/pets/${rex.id}/medications/${temp.id}/discontinue`)).statusCode).toBe(404);
    const all = (await desk.get(`/api/pets/${rex.id}/medications`)).json().items;
    expect(all.find((m: { id: string }) => m.id === temp.id).discontinuedAt).not.toBeNull();
    expect((await care.post(`/api/pets/${rex.id}/medications`, { name: "X", dosage: "1", times: [] })).statusCode).toBe(403);
  });

  it("shows today's doses as overdue / due, and records a scheduled dose exactly once", async () => {
    const today = (await care.get("/api/care/today")).json();
    const pet = today.stays.find((s: { id: string }) => s.id === stay.id).pets[0];
    expect(pet.doses.map((d: { status: string }) => d.status)).toEqual(["overdue", "due"]);
    const overdue = pet.doses[0];

    const give = () => care.post(`/api/reservations/${stay.id}/care-logs`, {
      kind: "medication", petId: rex.id, medicationId: medId, status: "given", scheduledFor: overdue.scheduledFor,
    });
    const first = await give();
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ medicationName: "Apoquel", dose: "16 mg tablet", medicationStatus: "given" });
    const again = await give();
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toMatch(/already been recorded/);

    const after = (await care.get("/api/care/today")).json().stays.find((s: { id: string }) => s.id === stay.id).pets[0];
    expect(after.doses.map((d: { status: string }) => d.status)).toEqual(["given", "due"]);

    // Voiding needs a reason and frees the slot; the voided entry stays in the log.
    expect((await care.post(`/api/care-logs/${first.json().id}/void`, {})).statusCode).toBe(400);
    expect((await care.post(`/api/care-logs/${first.json().id}/void`, { reason: "Wrong dog" })).statusCode).toBe(200);
    expect((await care.post(`/api/care-logs/${first.json().id}/void`, { reason: "again" })).statusCode).toBe(404);
    expect((await give()).statusCode).toBe(201);
    const log = (await care.get(`/api/reservations/${stay.id}/care-logs`)).json().items.filter((i: { kind: string }) => i.kind === "medication");
    expect(log).toHaveLength(2);
    expect(log.find((i: { voidedAt: string | null }) => i.voidedAt)).toMatchObject({ voidReason: "Wrong dog" });

    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${stay.id}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit.filter((a: string) => a === "care.medication_recorded")).toHaveLength(2);
    expect(audit).toContain("care.entry_voided");
  });

  it("rejects a scheduled time that isn't on the order", async () => {
    const wrong = await care.post(`/api/reservations/${stay.id}/care-logs`, {
      kind: "medication", petId: rex.id, medicationId: medId, status: "given",
      scheduledFor: new Date(Date.now() - 17 * 60_000).toISOString(),
    });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.fields[0].path).toBe("scheduledFor");
  });

  it("shows due medication on the dashboard", async () => {
    const due = (await desk.get("/api/dashboard/summary")).json().medicationDue;
    expect(due.map((d: { petName: string; medicationName: string }) => `${d.petName} ${d.medicationName}`)).toContain("Rex Apoquel");
  });
});

describe("care log", () => {
  it("records feeding and activities with validation", async () => {
    const fed = await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "feeding", petId: rex.id, meal: "breakfast", amountEaten: "most" });
    expect(fed.statusCode).toBe(201);
    expect((await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "feeding", petId: rex.id })).statusCode).toBe(400);
    expect((await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "walk", petId: rex.id, notes: "20 min" })).statusCode).toBe(201);
    const future = await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "potty", petId: rex.id, occurredAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.statusCode).toBe(400);
    const pet = (await care.get("/api/care/today")).json().stays.find((s: { id: string }) => s.id === stay.id).pets[0];
    expect(Object.keys(pet.lastCare).sort()).toEqual(["feeding", "medication", "walk"]);
  });

  it("only allows care on checked-in stays, for pets on the stay, by permitted staff", async () => {
    expect((await care.post(`/api/reservations/${stay.id}/care-logs`, { kind: "walk", petId: luna.id })).statusCode).toBe(422);
    expect((await employee.post(`/api/reservations/${stay.id}/care-logs`, { kind: "walk", petId: rex.id })).statusCode).toBe(403);
    const boarding = (await desk.get("/api/services")).json().items[0];
    const future = (await desk.post("/api/reservations", {
      customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [luna.id],
      startsAt: "2027-01-01T10:00:00Z", endsAt: "2027-01-02T10:00:00Z",
    })).json();
    const res = await care.post(`/api/reservations/${future.id}/care-logs`, { kind: "walk", petId: luna.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/checked in/);
  });

  it("cannot be rewritten or deleted even directly by the application role", async () => {
    const tenant = { orgId: org.orgId, userId: org.users.manager!.id };
    await expect(withTenant(ctx.db, tenant, (trx) => sql`update care_logs set notes = 'changed'`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`delete from care_logs`.execute(trx))).rejects.toThrow(/permission denied/);
    await expect(withTenant(ctx.db, tenant, (trx) => sql`update incidents set description = 'changed'`.execute(trx))).rejects.toThrow(/permission denied/);
  });
});

describe("incidents", () => {
  it("care staff report; only managers resolve; resolved incidents are locked", async () => {
    const created = await care.post("/api/incidents", {
      petId: rex.id, reservationId: stay.id, category: "altercation", severity: "medium",
      description: "Scuffle in group play; small scratch on left ear.", actionsTaken: "Separated, cleaned wound.", followUpRequired: true,
    });
    expect(created.statusCode).toBe(201);
    const inc = created.json();
    expect(inc).toMatchObject({ petName: "Rex", ownerNotified: false, resolvedAt: null });

    const upd = await care.patch(`/api/incidents/${inc.id}`, { ownerNotified: true, followUpNotes: "Owner called at 5pm", description: "rewritten" });
    expect(upd.statusCode).toBe(200);
    expect(upd.json()).toMatchObject({ ownerNotified: true, description: "Scuffle in group play; small scratch on left ear." });

    expect((await care.patch(`/api/incidents/${inc.id}`, { resolution: "Healed" })).statusCode).toBe(403);
    const today = (await care.get("/api/care/today")).json().stays.find((s: { id: string }) => s.id === stay.id).pets[0];
    expect(today.openIncidents).toBe(1);
    expect((await desk.get("/api/dashboard/summary")).json().openIncidents.map((i: { id: string }) => i.id)).toContain(inc.id);

    const resolved = await manager.patch(`/api/incidents/${inc.id}`, { resolution: "Checked at pickup; healing well." });
    expect(resolved.json()).toMatchObject({ resolution: "Checked at pickup; healing well." });
    expect(resolved.json().resolvedBy).toContain("manager");
    expect((await manager.patch(`/api/incidents/${inc.id}`, { followUpNotes: "late" })).statusCode).toBe(409);
    expect((await care.get("/api/incidents?open=true")).json().items.map((i: { id: string }) => i.id)).not.toContain(inc.id);
    const audit = (await manager.get(`/api/audit?entityType=incident&entityId=${inc.id}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(["incident.resolved", "incident.updated", "incident.reported"]);
  });

  it("rejects a pet that isn't on the named reservation", async () => {
    const res = await care.post("/api/incidents", { petId: luna.id, reservationId: stay.id, category: "other", severity: "low", description: "x" });
    expect(res.statusCode).toBe(422);
  });
});

describe("care tenant isolation", () => {
  it("hides care, medications and incidents from other organizations", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    expect((await intruder.get("/api/care/today")).json().stays).toHaveLength(0);
    expect((await intruder.get(`/api/reservations/${stay.id}/care-logs`)).statusCode).toBe(404);
    expect((await intruder.post(`/api/reservations/${stay.id}/care-logs`, { kind: "walk", petId: rex.id })).statusCode).toBe(404);
    expect((await intruder.get("/api/incidents")).json().items).toHaveLength(0);
    expect((await intruder.post("/api/incidents", { petId: rex.id, category: "other", severity: "low", description: "x" })).statusCode).toBe(422);
    expect((await intruder.post(`/api/pets/${rex.id}/medications`, { name: "X", dosage: "1", times: [] })).statusCode).toBe(404);
    expect((await intruder.get(`/api/pets/${rex.id}/medications`)).json().items).toHaveLength(0);
    const log = (await care.get(`/api/reservations/${stay.id}/care-logs`)).json().items[0];
    expect((await intruder.post(`/api/care-logs/${log.id}/void`, { reason: "x" })).statusCode).toBe(404);
  });
});
