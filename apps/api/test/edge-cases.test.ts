import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let owner: Awaited<ReturnType<typeof login>>;
let org: Awaited<ReturnType<typeof createOrg>>;
beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb);
  owner = await login(ctx.app, org.users.owner!.email);
});
afterAll(async () => { await ctx.close(); });

describe("edge cases", () => {
  it("saving an edit form with no changes succeeds and writes no history", async () => {
    const c = (await owner.post("/api/customers", { firstName: "No", lastName: "Change" })).json();
    const p = (await owner.post("/api/pets", { customerId: c.id, name: "Same", species: "dog" })).json();
    const svc = (await owner.post("/api/services", { name: "Svc", category: "daycare", priceCents: 100, priceUnit: "per_day" })).json();
    for (const [url, label] of [[`/api/customers/${c.id}`, "customer"], [`/api/pets/${p.id}`, "pet"], [`/api/services/${svc.id}`, "service"]] as const) {
      const res = await owner.patch(url, {});
      expect(res.statusCode, `${label}: ${res.body.slice(0, 200)}`).toBe(200);
    }
    const audit = (await owner.get(`/api/audit?entityId=${c.id}`)).json().items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(["customer.created"]);
  });

  it("handles names with markup and unicode safely", async () => {
    const c = (await owner.post("/api/customers", { firstName: "<script>alert(1)</script>", lastName: "Zoë O'Brien-Ünal" })).json();
    expect(c.firstName).toBe("<script>alert(1)</script>"); // stored as text; React escapes on display
    const found = (await owner.get(`/api/customers?q=${encodeURIComponent("o'brien")}`)).json().items;
    expect(found.map((x: { id: string }) => x.id)).toContain(c.id);
    expect((await owner.get(`/api/customers?q=${encodeURIComponent("%_\\")}`)).statusCode).toBe(200);
  });

  it("rejects over-long input and absurd pagination cleanly", async () => {
    expect((await owner.post("/api/customers", { firstName: "x".repeat(101), lastName: "y" })).statusCode).toBe(400);
    expect((await owner.get("/api/customers?limit=100000")).statusCode).toBe(400);
    expect((await owner.get("/api/customers?offset=-1")).statusCode).toBe(400);
  });

  it("returns 404, not 500, for unknown ids everywhere", async () => {
    const zero = "00000000-0000-4000-8000-000000000000";
    for (const url of [`/api/customers/${zero}`, `/api/pets/${zero}`, `/api/reservations/${zero}`, `/api/invoices/${zero}`, `/api/incidents/${zero}`, `/api/customers/${zero}/credits`]) {
      expect((await owner.get(url)).statusCode, url).toBe(404);
    }
    for (const url of [`/api/invoices/${zero}/payments`, `/api/invoices/${zero}/issue`, `/api/payments/${zero}/void`, `/api/care-logs/${zero}/void`]) {
      const res = await owner.post(url, { amountCents: 100, method: "cash", reason: "x" });
      expect([404, 400], `${url} → ${res.statusCode}`).toContain(res.statusCode);
    }
  });
});
