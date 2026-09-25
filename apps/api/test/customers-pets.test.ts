import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let client: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
beforeAll(async () => {
  ctx = await setupTestApp();
  const { users } = await createOrg(ctx.ownerDb, ["front_desk", "manager"]);
  client = await login(ctx.app, users.front_desk!.email);
  manager = await login(ctx.app, users.manager!.email);
});
afterAll(async () => { await ctx.close(); });

describe("customers", () => {
  it("creates, reads, searches, updates and archives a customer with an audit trail", async () => {
    const created = await client.post("/api/customers", {
      firstName: " Dana ", lastName: "Whitfield", email: "Dana.W@Example.com", phone: "555-0199", notes: "",
    });
    expect(created.statusCode).toBe(201);
    const customer = created.json();
    expect(customer).toMatchObject({ firstName: "Dana", email: "dana.w@example.com", notes: null, status: "active" });
    expect(customer).not.toHaveProperty("organizationId");

    const search = await client.get("/api/customers?q=whit");
    expect(search.json().items.map((c: { id: string }) => c.id)).toContain(customer.id);

    const updated = await client.patch(`/api/customers/${customer.id}`, { phone: "555-0100" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().phone).toBe("555-0100");

    const archived = await client.post(`/api/customers/${customer.id}/archive`);
    expect(archived.json().archivedAt).not.toBeNull();
    const afterArchive = await client.get("/api/customers?q=whit");
    expect(afterArchive.json().items).toHaveLength(0);

    const audit = await manager.get(`/api/audit?entityType=customer&entityId=${customer.id}`);
    const actions = audit.json().items.map((a: { action: string }) => a.action);
    expect(actions).toEqual(["customer.archived", "customer.updated", "customer.created"]);
    const update = audit.json().items[1];
    expect(update.changes).toEqual({ phone: { from: "555-0199", to: "555-0100" } });
  });

  it("returns field-level validation errors", async () => {
    const res = await client.post("/api/customers", { firstName: "", lastName: "X", email: "not-an-email" });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.fields.map((f: { path: string }) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["firstName", "email"]));
  });

  it("rejects a duplicate email among active customers", async () => {
    await client.post("/api/customers", { firstName: "A", lastName: "One", email: "dupe@example.com" });
    const res = await client.post("/api/customers", { firstName: "B", lastName: "Two", email: "dupe@example.com" });
    expect(res.statusCode).toBe(409);
    expect(JSON.stringify(res.json())).not.toMatch(/customers_email_key|duplicate key/);
  });

  it("returns 404 for malformed ids", async () => {
    expect((await client.get("/api/customers/not-a-uuid")).statusCode).toBe(404);
  });
});

describe("pets", () => {
  it("creates a pet for a customer, records vaccinations, and shows them on the pet", async () => {
    const customer = (await client.post("/api/customers", { firstName: "Lee", lastName: "Harper" })).json();
    const created = await client.post("/api/pets", {
      customerId: customer.id, name: "Maple", species: "dog", breed: "Beagle", sex: "female",
      dateOfBirth: "2021-04-02", weightGrams: 10500, allergies: "Beef",
    });
    expect(created.statusCode).toBe(201);
    const pet = created.json();
    expect(pet).toMatchObject({ name: "Maple", dateOfBirth: "2021-04-02", weightGrams: 10500 });

    const vax = await client.post(`/api/pets/${pet.id}/vaccinations`, { vaccine: "Rabies", administeredOn: "2025-01-01", expiresOn: "2028-01-01" });
    expect(vax.statusCode).toBe(201);
    const bad = await client.post(`/api/pets/${pet.id}/vaccinations`, { vaccine: "DHPP", administeredOn: "2025-02-01", expiresOn: "2025-01-01" });
    expect(bad.statusCode).toBe(400);

    const detail = (await client.get(`/api/pets/${pet.id}`)).json();
    expect(detail.owner.id).toBe(customer.id);
    expect(detail.vaccinations).toHaveLength(1);

    const voided = await client.post(`/api/pets/${pet.id}/vaccinations/${vax.json().id}/void`);
    expect(voided.statusCode).toBe(200);
    expect((await client.get(`/api/pets/${pet.id}`)).json().vaccinations).toHaveLength(0);

    const owner = (await client.get(`/api/customers/${customer.id}`)).json();
    expect(owner.pets.map((p: { name: string }) => p.name)).toEqual(["Maple"]);
  });

  it("refuses to add a pet to an archived customer", async () => {
    const customer = (await client.post("/api/customers", { firstName: "Old", lastName: "Account" })).json();
    await client.post(`/api/customers/${customer.id}/archive`);
    const res = await client.post("/api/pets", { customerId: customer.id, name: "Rex", species: "dog" });
    expect(res.statusCode).toBe(422);
  });
});
