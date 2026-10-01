import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let care: Awaited<ReturnType<typeof login>>;
let daycare: string;
let boarding: string;
let customerId: string;
let otherCustomerId: string;
let pip: string;
let seriesId: string;

const base = () => ({ customerId, locationId: org.locationId, serviceId: daycare, petIds: [pip], startTime: "07:30", endTime: "18:00" });
// New York is UTC-5 in January.
const est = (d: string, t: string) => `${d}T${t}:00-05:00`;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["manager", "front_desk", "care_attendant"]);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
  care = await login(ctx.app, org.users.care_attendant!.email);
  daycare = (await manager.post("/api/services", { name: "Daycare", category: "daycare", priceCents: 3800, priceUnit: "per_day" })).json().id;
  boarding = (await manager.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5500, priceUnit: "per_night" })).json().id;
  customerId = (await desk.post("/api/customers", { firstName: "Rita", lastName: "Repeat" })).json().id;
  otherCustomerId = (await desk.post("/api/customers", { firstName: "Olly", lastName: "Other" })).json().id;
  pip = (await desk.post("/api/pets", { customerId, name: "Pip", species: "dog" })).json().id;
  const max = (await desk.post("/api/pets", { customerId: otherCustomerId, name: "Max", species: "dog" })).json().id;
  // Open Mon–Fri 7–7, closed Mon Jan 18 2027, room for one daycare dog.
  await ctx.ownerDb.insertInto("locationHours").values([1, 2, 3, 4, 5].map((weekday) => ({
    organizationId: org.orgId, locationId: org.locationId, weekday, opensAt: "07:00", closesAt: "19:00",
  }))).execute();
  await ctx.ownerDb.insertInto("locationClosures").values({ organizationId: org.orgId, locationId: org.locationId, closedOn: "2027-01-18", reason: "MLK Day" }).execute();
  await ctx.ownerDb.insertInto("locationCapacities").values({ organizationId: org.orgId, locationId: org.locationId, category: "daycare", maxPets: 1 }).execute();
  // Max fills the only space on Wed Jan 13; Pip already has a booking on Fri Jan 22.
  await desk.post("/api/reservations", { customerId: otherCustomerId, locationId: org.locationId, serviceId: daycare, petIds: [max], startsAt: est("2027-01-13", "08:00"), endsAt: est("2027-01-13", "17:00"), status: "confirmed" });
  await desk.post("/api/reservations", { customerId, locationId: org.locationId, serviceId: daycare, petIds: [pip], startsAt: est("2027-01-22", "09:00"), endsAt: est("2027-01-22", "12:00"), status: "confirmed" });
});
afterAll(async () => { await ctx.close(); });

const count = async () => (await desk.get(`/api/reservations?customerId=${customerId}&limit=100`)).json().total as number;

describe("recurring reservations", () => {
  it("previews every date with the same checks as booking, without booking anything", async () => {
    const before = await count();
    const res = await desk.post("/api/reservation-series/preview", { ...base(), weekdays: [1, 3, 5, 6], firstDate: "2027-01-04", lastDate: "2027-01-31" });
    expect(res.statusCode).toBe(200);
    const { occurrences, bookable } = res.json();
    const skipped = Object.fromEntries(occurrences.filter((o: { ok: boolean }) => !o.ok).map((o: { date: string; reason: string }) => [o.date, o.reason]));
    expect(Object.keys(skipped)).toEqual(["2027-01-09", "2027-01-13", "2027-01-16", "2027-01-18", "2027-01-22", "2027-01-23", "2027-01-30"]);
    expect(skipped["2027-01-09"]).toBe("The location is closed on Saturdays.");
    expect(skipped["2027-01-13"]).toBe("Daycare is full for this day: Jan 13 (1/1 booked).");
    expect(skipped["2027-01-18"]).toBe("The location is closed that day (MLK Day).");
    expect(skipped["2027-01-22"]).toBe("Pip already has a reservation during this time.");
    expect(bookable).toBe(9);
    expect(occurrences[0]).toMatchObject({ date: "2027-01-04", startsAt: "2027-01-04T12:30:00.000Z", endsAt: "2027-01-04T23:00:00.000Z", ok: true });
    expect(await count()).toBe(before);
  });

  it("books the dates that pass and links them as a series", async () => {
    const before = await count();
    expect((await care.post("/api/reservation-series", { ...base(), weekdays: [1, 3, 5], firstDate: "2027-01-04", lastDate: "2027-01-31" })).statusCode).toBe(403);
    const res = await desk.post("/api/reservation-series", { ...base(), weekdays: [1, 3, 5], firstDate: "2027-01-04", lastDate: "2027-01-31", notes: "Regular" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    seriesId = body.seriesId;
    expect(body.bookable).toBe(9);
    expect(body.occurrences.filter((o: { ok: boolean }) => !o.ok).map((o: { date: string }) => o.date)).toEqual(["2027-01-13", "2027-01-18", "2027-01-22"]);
    expect(await count()).toBe(before + 9);

    const first = (await desk.get(`/api/reservations/${body.occurrences[0].reservationId}`)).json();
    expect(first).toMatchObject({ status: "confirmed", notes: "Regular", series: { id: seriesId, weekdays: [1, 3, 5], startTime: "07:30", endTime: "18:00", upcoming: 9 } });
    const series = (await care.get(`/api/reservation-series/${seriesId}`)).json();
    expect(series.occurrences).toHaveLength(9);
    const audit = (await manager.get(`/api/audit?entityType=reservation_series&entityId=${seriesId}`)).json().items[0];
    expect(audit.changes.skipped.map((s: { date: string }) => s.date)).toEqual(["2027-01-13", "2027-01-18", "2027-01-22"]);
  });

  it("keeps local times across a DST change", async () => {
    const { occurrences } = (await desk.post("/api/reservation-series/preview", { ...base(), weekdays: [1, 5], firstDate: "2027-03-12", lastDate: "2027-03-15" })).json();
    expect(occurrences.map((o: { startsAt: string }) => o.startsAt)).toEqual(["2027-03-12T12:30:00.000Z", "2027-03-15T11:30:00.000Z"]);
  });

  it("validates the pattern", async () => {
    const fields = async (body: object) => (await desk.post("/api/reservation-series/preview", { ...base(), ...body })).json().error.fields.map((f: { path: string; message: string }) => `${f.path}: ${f.message}`);
    expect(await fields({ weekdays: [1], firstDate: "2027-02-01", lastDate: "2027-02-28", serviceId: boarding }))
      .toEqual(["serviceId: Repeating bookings are for same-day services such as daycare or grooming. Book overnight stays one at a time."]);
    expect(await fields({ weekdays: [1], firstDate: "2027-02-01", lastDate: "2027-02-28", endTime: "07:00" })).toEqual(["endTime: Pick-up must be after drop-off on the same day"]);
    expect(await fields({ weekdays: [1], firstDate: "2027-02-01", lastDate: "2027-09-01" })).toEqual(["lastDate: A series can run for up to six months"]);
    expect(await fields({ weekdays: [0, 1, 2, 3, 4, 5, 6], firstDate: "2027-02-01", lastDate: "2027-06-30" })).toEqual(["lastDate: That's 150 dates; a series can have up to 100."]);
    expect(await fields({ weekdays: [0], firstDate: "2027-02-01", lastDate: "2027-02-06" })).toEqual(["weekdays: None of the chosen days fall between those dates."]);
    expect(await fields({ weekdays: [], firstDate: "2027-02-01", lastDate: "2027-02-06" })).toEqual(["weekdays: Choose at least one day"]);
  });

  it("refuses to create a series when no date can be booked", async () => {
    const res = await desk.post("/api/reservation-series", { ...base(), weekdays: [6, 0], firstDate: "2027-02-06", lastDate: "2027-02-14" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("nothing_to_book");
    expect((await manager.get("/api/audit?entityType=reservation_series")).json().items).toHaveLength(1);
  });

  it("cancels this and following occurrences that haven't started, with one reason", async () => {
    expect((await care.post(`/api/reservation-series/${seriesId}/cancel`, { fromDate: "2027-01-20", reason: "Moving" })).statusCode).toBe(403);
    expect((await desk.post(`/api/reservation-series/${seriesId}/cancel`, { fromDate: "2027-01-20" })).statusCode).toBe(400);
    const res = await desk.post(`/api/reservation-series/${seriesId}/cancel`, { fromDate: "2027-01-20", reason: "Family moving away" });
    expect(res.json()).toEqual({ cancelled: 4 }); // Jan 20, 25, 27, 29
    const series = (await desk.get(`/api/reservation-series/${seriesId}`)).json();
    expect(series.occurrences.map((o: { status: string }) => o.status)).toEqual([...Array(5).fill("confirmed"), ...Array(4).fill("cancelled")]);
    const last = (await desk.get(`/api/reservations/${series.occurrences[8].id}`)).json();
    expect(last).toMatchObject({ status: "cancelled", cancellationReason: "Family moving away", series: { upcoming: 5 } });
    expect((await desk.post(`/api/reservation-series/${seriesId}/cancel`, { fromDate: "2027-01-20", reason: "Again" })).json()).toEqual({ cancelled: 0 });
  });

  it("other organizations can't see, cancel or book against our customers", async () => {
    const other = await createOrg(ctx.ownerDb, ["owner"]);
    const outsider = await login(ctx.app, other.users.owner!.email);
    expect((await outsider.get(`/api/reservation-series/${seriesId}`)).statusCode).toBe(404);
    expect((await outsider.post(`/api/reservation-series/${seriesId}/cancel`, { fromDate: "2027-01-01", reason: "x" })).statusCode).toBe(404);
    const theirDaycare = (await outsider.post("/api/services", { name: "Daycare", category: "daycare", priceCents: 1000, priceUnit: "per_day" })).json().id;
    const res = await outsider.post("/api/reservation-series/preview", {
      customerId, locationId: other.locationId, serviceId: theirDaycare, petIds: [pip], weekdays: [1], startTime: "08:00", endTime: "17:00", firstDate: "2027-02-01", lastDate: "2027-02-28",
    });
    expect(res.json().error.fields[0].path).toBe("customerId");
  });
});
