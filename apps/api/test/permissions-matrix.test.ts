/**
 * Every role × every protected endpoint, checked against the role→permission map in
 * packages/shared/src/permissions.ts. Bodies are deliberately incomplete: authorization runs
 * before validation, so permitted roles get 400 (or 404/409) and never 403, and nothing may 500.
 */
import { hasPermission, ROLES, type Permission, type Role } from "@pawguild/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let clients: Record<Role, Awaited<ReturnType<typeof login>>>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await setupTestApp();
  const org = await createOrg(ctx.ownerDb, [...ROLES]);
  clients = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await login(ctx.app, org.users[r]!.email)]))) as typeof clients;
  const owner = clients.owner;
  ids.location = org.locationId;
  const svc = (await owner.post("/api/services", { name: "Boarding", category: "boarding", priceCents: 5000, priceUnit: "per_night" })).json();
  const customer = (await owner.post("/api/customers", { firstName: "Matrix", lastName: "Test" })).json();
  const pet = (await owner.post("/api/pets", { customerId: customer.id, name: "Neo", species: "dog" })).json();
  const now = Date.now();
  const r = (await owner.post("/api/reservations", {
    customerId: customer.id, locationId: org.locationId, serviceId: svc.id, petIds: [pet.id],
    startsAt: new Date(now - 3600_000).toISOString(), endsAt: new Date(now + 86400_000).toISOString(), status: "confirmed",
  })).json();
  await owner.post(`/api/reservations/${r.id}/status`, { status: "checked_in" });
  const log = (await owner.post(`/api/reservations/${r.id}/care-logs`, { kind: "walk", petId: pet.id })).json();
  const inc = (await owner.post("/api/incidents", { petId: pet.id, category: "other", severity: "low", description: "x" })).json();
  const inv = (await owner.post(`/api/reservations/${r.id}/invoice`)).json();
  await owner.post(`/api/invoices/${inv.id}/issue`);
  const paid = (await owner.post(`/api/invoices/${inv.id}/payments`, { amountCents: 100, method: "cash" })).json();
  Object.assign(ids, { customer: customer.id, pet: pet.id, reservation: r.id, careLog: log.id, incident: inc.id, invoice: inv.id, payment: paid.payments[0].id });
});
afterAll(async () => { await ctx.close(); });

type Probe = { name: string; method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; url: () => string; body?: unknown; allowed: (role: Role) => boolean };
const needs = (p: Permission) => (role: Role) => hasPermission(role, p);
const anyone = () => true;

const probes: Probe[] = [
  { name: "view dashboard", method: "GET", url: () => "/api/dashboard/summary", allowed: anyone },
  { name: "list locations", method: "GET", url: () => "/api/locations", allowed: anyone },
  { name: "list customers", method: "GET", url: () => "/api/customers", allowed: needs("customers:read") },
  { name: "create customer", method: "POST", url: () => "/api/customers", body: {}, allowed: needs("customers:write") },
  { name: "edit customer", method: "PATCH", url: () => `/api/customers/${ids.customer}`, body: { firstName: "" }, allowed: needs("customers:write") },
  { name: "archive customer", method: "POST", url: () => `/api/customers/00000000-0000-4000-8000-000000000000/archive`, allowed: needs("customers:write") },
  { name: "list pets", method: "GET", url: () => "/api/pets", allowed: needs("pets:read") },
  { name: "create pet", method: "POST", url: () => "/api/pets", body: {}, allowed: needs("pets:write") },
  { name: "record vaccination", method: "POST", url: () => `/api/pets/${ids.pet}/vaccinations`, body: {}, allowed: needs("pets:write") },
  { name: "add medication", method: "POST", url: () => `/api/pets/${ids.pet}/medications`, body: {}, allowed: needs("pets:write") },
  { name: "list reservations", method: "GET", url: () => "/api/reservations", allowed: needs("reservations:read") },
  { name: "create reservation", method: "POST", url: () => "/api/reservations", body: {}, allowed: needs("reservations:write") },
  { name: "edit reservation", method: "PATCH", url: () => `/api/reservations/${ids.reservation}`, body: { endsAt: "bad" }, allowed: needs("reservations:write") },
  { name: "cancel reservation", method: "POST", url: () => `/api/reservations/${ids.reservation}/status`, body: { status: "cancelled" }, allowed: needs("reservations:write") },
  { name: "check in", method: "POST", url: () => `/api/reservations/${ids.reservation}/status`, body: { status: "checked_in" }, allowed: needs("stays:check_in_out") },
  { name: "check out", method: "POST", url: () => `/api/reservations/${ids.reservation}/status`, body: { status: "bogus" }, allowed: needs("reservations:read") },
  { name: "assign kennels", method: "PUT", url: () => `/api/reservations/${ids.reservation}/assignments`, body: {},
    allowed: (r) => hasPermission(r, "reservations:write") || hasPermission(r, "stays:check_in_out") },
  { name: "list services", method: "GET", url: () => "/api/services", allowed: needs("reservations:read") },
  { name: "create service", method: "POST", url: () => "/api/services", body: {}, allowed: needs("services:manage") },
  { name: "list kennels", method: "GET", url: () => "/api/resources", allowed: needs("reservations:read") },
  { name: "create kennel", method: "POST", url: () => "/api/resources", body: {}, allowed: needs("resources:manage") },
  { name: "set capacity", method: "PUT", url: () => `/api/locations/${ids.location}/capacity`, body: {}, allowed: needs("locations:manage") },
  { name: "set tax rate", method: "PUT", url: () => `/api/locations/${ids.location}/tax-rate`, body: {}, allowed: needs("locations:manage") },
  { name: "check-out summary", method: "GET", url: () => `/api/reservations/${ids.reservation}/checkout-summary`, allowed: needs("reservations:read") },
  { name: "today's care", method: "GET", url: () => "/api/care/today", allowed: needs("reservations:read") },
  { name: "log care", method: "POST", url: () => `/api/reservations/${ids.reservation}/care-logs`, body: {}, allowed: needs("care:record") },
  { name: "void care entry", method: "POST", url: () => `/api/care-logs/${ids.careLog}/void`, body: {}, allowed: needs("care:record") },
  { name: "list incidents", method: "GET", url: () => "/api/incidents", allowed: needs("reservations:read") },
  { name: "report incident", method: "POST", url: () => "/api/incidents", body: {}, allowed: needs("incidents:record") },
  { name: "resolve incident", method: "PATCH", url: () => `/api/incidents/${ids.incident}`, body: { resolution: "", ownerNotified: "x" },
    allowed: needs("incidents:record") },
  { name: "list invoices", method: "GET", url: () => "/api/invoices", allowed: needs("billing:read") },
  { name: "create invoice", method: "POST", url: () => "/api/invoices", body: {}, allowed: needs("billing:write") },
  { name: "record payment", method: "POST", url: () => `/api/invoices/${ids.invoice}/payments`, body: {}, allowed: needs("billing:write") },
  { name: "apply credit", method: "POST", url: () => `/api/invoices/${ids.invoice}/apply-credit`, body: {}, allowed: needs("billing:write") },
  { name: "credit note", method: "POST", url: () => `/api/invoices/${ids.invoice}/credit-notes`, body: {}, allowed: needs("billing:refund") },
  { name: "refund", method: "POST", url: () => `/api/invoices/${ids.invoice}/refunds`, body: {}, allowed: needs("billing:refund") },
  { name: "void payment", method: "POST", url: () => `/api/payments/${ids.payment}/void`, body: {}, allowed: needs("billing:refund") },
  { name: "view account credit", method: "GET", url: () => `/api/customers/${ids.customer}/credits`, allowed: needs("billing:read") },
  { name: "take deposit", method: "POST", url: () => `/api/customers/${ids.customer}/credits`, body: {}, allowed: needs("billing:write") },
  { name: "refund credit", method: "POST", url: () => `/api/customers/${ids.customer}/credits/refund`, body: {}, allowed: needs("billing:refund") },
  { name: "list staff", method: "GET", url: () => "/api/employees", allowed: needs("employees:read") },
  { name: "add staff", method: "POST", url: () => "/api/employees", body: {}, allowed: needs("employees:manage") },
  { name: "change password (self)", method: "POST", url: () => "/api/auth/change-password", body: {}, allowed: anyone },
  { name: "audit history", method: "GET", url: () => "/api/audit", allowed: needs("audit:read") },
  { name: "sales report", method: "GET", url: () => "/api/reports/sales?from=2026-01-01&to=2026-01-31", allowed: needs("reports:read") },
  { name: "payments report", method: "GET", url: () => "/api/reports/payments", allowed: needs("reports:read") },
  { name: "balances report", method: "GET", url: () => "/api/reports/balances", allowed: needs("reports:read") },
  { name: "add location", method: "POST", url: () => "/api/locations", body: {}, allowed: needs("locations:manage") },
  { name: "edit location", method: "PATCH", url: () => `/api/locations/${ids.location}`, body: { name: "" }, allowed: needs("locations:manage") },
  { name: "set business hours", method: "PUT", url: () => `/api/locations/${ids.location}/hours`, body: {}, allowed: needs("locations:manage") },
  { name: "add closure", method: "POST", url: () => `/api/locations/${ids.location}/closures`, body: {}, allowed: needs("locations:manage") },
  { name: "remove closure", method: "DELETE", url: () => `/api/locations/${ids.location}/closures/00000000-0000-4000-8000-000000000000`, allowed: needs("locations:manage") },
  { name: "occupancy report", method: "GET", url: () => "/api/reports/occupancy?from=2026-01-01&to=2026-01-07", allowed: needs("reports:read") },
];

describe("permission matrix", () => {
  for (const role of ROLES) {
    it(`${role}: allowed exactly what the role map grants, and nothing errors`, async () => {
      const mismatches: string[] = [];
      for (const p of probes) {
        const c = clients[role];
        const res = p.method === "GET" ? await c.get(p.url()) : p.method === "POST" ? await c.post(p.url(), p.body ?? {})
          : p.method === "PATCH" ? await c.patch(p.url(), p.body ?? {}) : p.method === "DELETE" ? await c.delete(p.url())
          : await c.put(p.url(), p.body ?? {});
        if (res.statusCode >= 500) mismatches.push(`${p.name}: server error ${res.statusCode} ${res.body.slice(0, 120)}`);
        const denied = res.statusCode === 403;
        if (denied === p.allowed(role)) mismatches.push(`${p.name}: expected ${p.allowed(role) ? "allowed" : "403"}, got ${res.statusCode}`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});
