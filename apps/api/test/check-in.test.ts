import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let boarding: { id: string };
let customer: { id: string };

const at = (d: string, t: string) => `${d}T${t}:00-04:00`;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  customer = (await desk.post("/api/customers", { firstName: "Vax", lastName: "Check" })).json();
});
afterAll(async () => { await ctx.close(); });

async function confirmedStay(petIds: string[], start = at("2026-07-01", "14:00"), end = at("2026-07-04", "11:00")) {
  const r = (await desk.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds, startsAt: start, endsAt: end, status: "confirmed",
  })).json();
  return r as { id: string; vaccinationCheck: { petName: string; ok: boolean; checks: { vaccine: string; state: string }[] }[] };
}
const newPet = async (name: string, species = "dog") =>
  (await desk.post("/api/pets", { customerId: customer.id, name, species })).json() as { id: string };
const vaccinate = (petId: string, vaccine: string, expiresOn: string) =>
  desk.post(`/api/pets/${petId}/vaccinations`, { vaccine, expiresOn });
const checkIn = (id: string, body: Record<string, unknown> = {}) =>
  desk.post(`/api/reservations/${id}/status`, { status: "checked_in", ...body });

describe("service vaccination requirements", () => {
  it("are configured per species by managers and audited", async () => {
    const res = await manager.post("/api/services", {
      name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night",
      vaccineRequirements: { dog: ["Rabies", "DHPP", "rabies"], cat: ["Rabies", "FVRCP"] },
    });
    expect(res.statusCode).toBe(201);
    boarding = res.json();
    expect(res.json().vaccineRequirements).toEqual({ dog: ["DHPP", "Rabies"], cat: ["FVRCP", "Rabies"], other: [] });

    const updated = await manager.patch(`/api/services/${boarding.id}`, { vaccineRequirements: { dog: ["Rabies", "DHPP", "Bordetella"] } });
    expect(updated.json().vaccineRequirements.dog).toEqual(["Bordetella", "DHPP", "Rabies"]);
    expect(updated.json().vaccineRequirements.cat).toEqual(["FVRCP", "Rabies"]); // untouched
    const audit = (await manager.get(`/api/audit?entityType=service&entityId=${boarding.id}`)).json().items[0];
    expect(audit.changes["vaccines.dog"].to).toEqual(["Rabies", "DHPP", "Bordetella"]);

    expect((await desk.patch(`/api/services/${boarding.id}`, { vaccineRequirements: { dog: [] } })).statusCode).toBe(403);
  });
});

describe("check-in vaccination verification", () => {
  it("blocks check-in, explains exactly what's missing, and allows it once records are current", async () => {
    const rex = await newPet("Rex");
    await vaccinate(rex.id, "rabies", "2027-01-01");      // matches case-insensitively
    await vaccinate(rex.id, "DHPP", "2026-07-02");        // expires mid-stay
    const r = await confirmedStay([rex.id]);
    expect(r.vaccinationCheck[0]!.checks.map((c) => [c.vaccine, c.state])).toEqual([
      ["Bordetella", "missing"], ["DHPP", "expires_during_stay"], ["Rabies", "current"],
    ]);

    const blocked = await checkIn(r.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("vaccinations_required");
    expect(blocked.json().error.message).toContain("Rex: Bordetella (not on file), DHPP (expires during stay)");
    expect((await desk.get(`/api/reservations/${r.id}`)).json().status).toBe("confirmed");

    await vaccinate(rex.id, "Bordetella", "2027-01-01");
    await vaccinate(rex.id, "DHPP", "2027-06-01");        // renewal: latest record wins
    const ok = await checkIn(r.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("checked_in");
  });

  it("ignores voided records and uses per-species requirements", async () => {
    const tom = await newPet("Tom", "cat");
    await vaccinate(tom.id, "Rabies", "2027-01-01");
    const fvrcp = (await vaccinate(tom.id, "FVRCP", "2027-01-01")).json();
    await desk.post(`/api/pets/${tom.id}/vaccinations/${fvrcp.id}/void`);
    const r = await confirmedStay([tom.id], at("2026-08-01", "14:00"), at("2026-08-02", "11:00"));
    expect(r.vaccinationCheck[0]!.checks.map((c) => [c.vaccine, c.state])).toEqual([["FVRCP", "missing"], ["Rabies", "current"]]);
    expect((await checkIn(r.id)).statusCode).toBe(409);
  });

  it("lets only managers override, and only with a reason, recorded in the audit log", async () => {
    const pip = await newPet("Pip");
    const r = await confirmedStay([pip.id], at("2026-09-01", "14:00"), at("2026-09-02", "11:00"));
    expect((await checkIn(r.id, { overrideVaccinations: true, overrideReason: "Vet faxed records" })).statusCode).toBe(403);

    const noReason = await manager.post(`/api/reservations/${r.id}/status`, { status: "checked_in", overrideVaccinations: true });
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.fields[0].path).toBe("overrideReason");

    const ok = await manager.post(`/api/reservations/${r.id}/status`, { status: "checked_in", overrideVaccinations: true, overrideReason: "Vet faxed records; entering tomorrow" });
    expect(ok.statusCode).toBe(200);
    const audit = (await manager.get(`/api/audit?entityType=reservation&entityId=${r.id}`)).json().items[0];
    expect(audit.action).toBe("reservation.checked_in");
    expect(audit.changes.vaccinationOverride).toEqual({
      reason: "Vet faxed records; entering tomorrow",
      problems: "Pip: Bordetella (not on file), DHPP (not on file), Rabies (not on file)",
    });
  });

  it("does not require anything for services without requirements", async () => {
    const daycare = (await manager.post("/api/services", { name: "Daycare", category: "daycare", priceCents: 3000, priceUnit: "per_day" })).json();
    const bo = await newPet("Bo");
    const r = (await desk.post("/api/reservations", {
      customerId: customer.id, locationId: org.locationId, serviceId: daycare.id, petIds: [bo.id],
      startsAt: at("2026-10-01", "08:00"), endsAt: at("2026-10-01", "17:00"), status: "confirmed",
    })).json();
    expect(r.vaccinationCheck[0].checks).toEqual([]);
    expect((await checkIn(r.id)).statusCode).toBe(200);
  });

  it("flags arrivals needing vaccinations on the dashboard", async () => {
    const zed = await newPet("Zed");
    const now = new Date();
    const r = (await desk.post("/api/reservations", {
      customerId: customer.id, locationId: org.locationId, serviceId: boarding.id, petIds: [zed.id],
      startsAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400_000).toISOString(), status: "confirmed",
    })).json();
    const arrival = (await desk.get("/api/dashboard/summary")).json().arrivals.find((a: { id: string }) => a.id === r.id);
    expect(arrival.petsNeedingVaccinations).toEqual(["Zed"]);
  });

  it("keeps requirements private to each organization", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const intruder = await login(ctx.app, other.users.owner!.email);
    expect((await intruder.patch(`/api/services/${boarding.id}`, { vaccineRequirements: { dog: [] } })).statusCode).toBe(404);
    expect((await manager.get("/api/services")).json().items.find((s: { id: string }) => s.id === boarding.id).vaccineRequirements.dog).toHaveLength(3);
  });
});
