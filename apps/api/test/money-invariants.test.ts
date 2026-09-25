/**
 * Randomized money scenarios and concurrency. After every operation the books must reconcile:
 *   balance = total - credit notes - (active payments - invoice refunds)
 *   invoice totals = invoiceTotals(lines, rate)
 *   account credit = sum of ledger entries >= 0
 * Refused operations must be 4xx and must not change anything.
 */
import { invoiceTotals } from "@pawguild/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrg, login, setupTestApp } from "./helpers";

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let org: Awaited<ReturnType<typeof createOrg>>;
let manager: Awaited<ReturnType<typeof login>>;
let desk: Awaited<ReturnType<typeof login>>;
let owner: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  ctx = await setupTestApp();
  org = await createOrg(ctx.ownerDb, ["owner", "manager", "front_desk"]);
  owner = await login(ctx.app, org.users.owner!.email);
  manager = await login(ctx.app, org.users.manager!.email);
  desk = await login(ctx.app, org.users.front_desk!.email);
});
afterAll(async () => { await ctx.close(); });

/** Small deterministic PRNG so failures are reproducible by seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}

async function snapshot(invoiceId: string, customerId: string) {
  const inv = (await desk.get(`/api/invoices/${invoiceId}`)).json();
  const credit = (await desk.get(`/api/customers/${customerId}/credits`)).json();
  return { inv, credit };
}

function assertReconciles(s: Awaited<ReturnType<typeof snapshot>>, label: string) {
  const { inv, credit } = s;
  const lines = inv.lines.map((l: { quantity: number; unitPriceCents: number; discountCents: number; taxable: boolean }) => l);
  const expectedTotals = invoiceTotals(lines, inv.taxRateBps);
  expect(inv.totals, `${label}: totals`).toMatchObject({ subtotalCents: expectedTotals.subtotalCents, discountCents: expectedTotals.discountCents, taxCents: expectedTotals.taxCents, totalCents: expectedTotals.totalCents });
  const payments = inv.payments.filter((p: { voidedAt: string | null }) => !p.voidedAt).reduce((n: number, p: { amountCents: number }) => n + p.amountCents, 0);
  const refunds = inv.refunds.reduce((n: number, r: { amountCents: number }) => n + r.amountCents, 0);
  const credits = inv.creditNotes.reduce((n: number, c: { amountCents: number }) => n + c.amountCents, 0);
  expect(inv.balanceCents, `${label}: balance`).toBe(inv.totals.totalCents - credits - (payments - refunds));
  expect(credits, `${label}: credit notes within total`).toBeLessThanOrEqual(inv.totals.totalCents);
  expect(refunds, `${label}: refunds within payments`).toBeLessThanOrEqual(payments);
  const ledger = credit.entries.reduce((n: number, e: { amountCents: number }) => n + e.amountCents, 0);
  expect(credit.balanceCents, `${label}: credit ledger`).toBe(ledger);
  expect(credit.balanceCents, `${label}: credit non-negative`).toBeGreaterThanOrEqual(0);
  expect(inv.customerCreditCents).toBe(credit.balanceCents);
}

describe("randomized billing scenarios", () => {
  const SCENARIOS = 40;
  const OPS = 15;

  it(`${SCENARIOS} scenarios × ${OPS} operations always reconcile`, async () => {
    const opCounts: Record<string, { ok: number; refused: number }> = {};
    const tally = (op: string, ok: boolean) => { opCounts[op] ??= { ok: 0, refused: 0 }; opCounts[op][ok ? "ok" : "refused"]++; };

    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const r = rng(seed);
      await owner.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: r.pick([0, 500, 625, 825, 1000]) });
      const customer = (await desk.post("/api/customers", { firstName: "Seed", lastName: String(seed) })).json();
      const draft = (await desk.post("/api/invoices", { customerId: customer.id, locationId: org.locationId })).json();
      for (let i = r.int(1, 4); i > 0; i--) {
        const quantity = r.int(1, 5); const unit = r.int(1, 20000);
        await desk.post(`/api/invoices/${draft.id}/lines`, {
          description: `Item ${i}`, quantity, unitPriceCents: unit, taxable: r.chance(0.5),
          discountCents: r.chance(0.3) ? r.int(0, quantity * unit) : 0,
        });
      }
      await desk.post(`/api/invoices/${draft.id}/issue`);

      for (let step = 0; step < OPS; step++) {
        const before = await snapshot(draft.id, customer.id);
        const { inv, credit } = before;
        const op = r.pick(["pay", "payFull", "payFull", "overpay", "creditNote", "creditNote", "refund", "refund", "refund", "deposit", "applyCredit", "voidPayment", "refundCredit"] as const);
        let res;
        let shouldSucceed: boolean;
        switch (op) {
          case "pay": {
            const amt = inv.balanceCents > 0 ? r.int(1, inv.balanceCents) : r.int(1, 500);
            shouldSucceed = inv.balanceCents > 0;
            res = await desk.post(`/api/invoices/${draft.id}/payments`, { amountCents: amt, method: r.pick(["card", "cash", "check", "other"]) });
            break;
          }
          case "payFull":
            shouldSucceed = inv.balanceCents > 0;
            res = await desk.post(`/api/invoices/${draft.id}/payments`, { amountCents: Math.max(inv.balanceCents, 1), method: "card" });
            break;
          case "overpay":
            shouldSucceed = false;
            res = await desk.post(`/api/invoices/${draft.id}/payments`, { amountCents: Math.max(inv.balanceCents, 0) + r.int(1, 1000), method: "card" });
            break;
          case "creditNote": {
            const creditable = inv.totals.totalCents - inv.creditNotesCents;
            const amt = r.chance(0.8) && creditable > 0 ? r.int(1, creditable) : creditable + r.int(1, 1000);
            shouldSucceed = amt <= creditable;
            res = await manager.post(`/api/invoices/${draft.id}/credit-notes`, { amountCents: amt, reason: `seed ${seed}` });
            break;
          }
          case "refund": {
            const overpaid = -inv.balanceCents;
            const amt = overpaid > 0 && r.chance(0.8) ? r.int(1, overpaid) : Math.max(overpaid, 0) + r.int(1, 1000);
            shouldSucceed = overpaid > 0 && amt <= overpaid;
            res = await manager.post(`/api/invoices/${draft.id}/refunds`, { amountCents: amt, method: r.pick(["card", "cash", "account_credit"]), reason: "r" });
            break;
          }
          case "deposit":
            shouldSucceed = true;
            res = await desk.post(`/api/customers/${customer.id}/credits`, { amountCents: r.int(1, 10000), method: "cash" });
            break;
          case "applyCredit": {
            const max = Math.min(credit.balanceCents, inv.balanceCents);
            const amt = max > 0 && r.chance(0.8) ? r.int(1, max) : Math.max(max, 0) + r.int(1, 1000);
            shouldSucceed = max > 0 && amt <= max;
            res = await desk.post(`/api/invoices/${draft.id}/apply-credit`, { amountCents: amt });
            break;
          }
          case "voidPayment": {
            const active: { id: string }[] = inv.payments.filter((p: { voidedAt: string | null }) => !p.voidedAt);
            if (active.length === 0) { shouldSucceed = false; res = await manager.post(`/api/payments/00000000-0000-4000-8000-000000000000/void`, { reason: "x" }); break; }
            shouldSucceed = inv.refunds.length === 0;
            res = await manager.post(`/api/payments/${r.pick(active).id}/void`, { reason: "fuzz" });
            break;
          }
          case "refundCredit": {
            const amt = credit.balanceCents > 0 && r.chance(0.8) ? r.int(1, credit.balanceCents) : credit.balanceCents + r.int(1, 1000);
            shouldSucceed = amt <= credit.balanceCents;
            res = await manager.post(`/api/customers/${customer.id}/credits/refund`, { amountCents: amt, method: "cash", reason: "fuzz" });
            break;
          }
        }
        const label = `seed ${seed} step ${step} ${op} → ${res.statusCode} ${res.body.slice(0, 160)}`;
        expect(res.statusCode, label).toBeLessThan(500);
        const ok = res.statusCode < 300;
        expect(ok, `${label} (expected ${shouldSucceed ? "success" : "refusal"})`).toBe(shouldSucceed);
        tally(op, ok);
        const after = await snapshot(draft.id, customer.id);
        assertReconciles(after, label);
        if (!ok) {
          expect(after.inv.balanceCents, `${label}: refused op changed balance`).toBe(inv.balanceCents);
          expect(after.credit.balanceCents, `${label}: refused op changed credit`).toBe(credit.balanceCents);
        }
      }
    }
    // Make sure the fuzz actually exercised both outcomes of each operation.
    for (const op of ["pay", "creditNote", "refund", "applyCredit", "refundCredit"]) {
      expect(opCounts[op]!.ok, `${op} never succeeded`).toBeGreaterThan(0);
      expect(opCounts[op]!.refused, `${op} never refused`).toBeGreaterThan(0);
    }
    console.log("operation outcomes:", JSON.stringify(opCounts));
  }, 180_000);

  it("organization totals match the sum of every invoice", async () => {
    const all = (await desk.get("/api/invoices?limit=200")).json().items.filter((i: { status: string }) => i.status === "issued");
    const owed = all.reduce((n: number, i: { balanceCents: number }) => n + Math.max(i.balanceCents, 0), 0);
    const overpaid = all.filter((i: { balanceCents: number }) => i.balanceCents < 0).length;
    const dash = (await desk.get("/api/dashboard/summary")).json().outstanding;
    expect(dash).toEqual({ cents: owed, invoices: all.filter((i: { balanceCents: number }) => i.balanceCents > 0).length, overpaidInvoices: overpaid });
  });
});

describe("simultaneous requests", () => {
  async function issuedInvoice(amount: number) {
    const c = (await desk.post("/api/customers", { firstName: "Race", lastName: String(amount) })).json();
    const inv = (await desk.post("/api/invoices", { customerId: c.id, locationId: org.locationId })).json();
    await desk.post(`/api/invoices/${inv.id}/lines`, { description: "Item", quantity: 1, unitPriceCents: amount });
    await desk.post(`/api/invoices/${inv.id}/issue`);
    return { customerId: c.id as string, invoiceId: inv.id as string };
  }

  it("two staff paying the full balance at once: exactly one payment is taken", async () => {
    await owner.put(`/api/locations/${org.locationId}/tax-rate`, { taxRateBps: 0 });
    const { invoiceId } = await issuedInvoice(5000);
    const results = await Promise.all([1, 2, 3].map(() => desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 5000, method: "card" })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400, 400]);
    const inv = (await desk.get(`/api/invoices/${invoiceId}`)).json();
    expect(inv).toMatchObject({ paidCents: 5000, balanceCents: 0 });
    expect(inv.payments).toHaveLength(1);
  });

  it("applying the same credit to several invoices at once never overdraws it", async () => {
    const first = await issuedInvoice(3000);
    await desk.post(`/api/customers/${first.customerId}/credits`, { amountCents: 3000, method: "cash" });
    const invoices = [first.invoiceId];
    for (let i = 0; i < 4; i++) {
      const inv = (await desk.post("/api/invoices", { customerId: first.customerId, locationId: org.locationId })).json();
      await desk.post(`/api/invoices/${inv.id}/lines`, { description: "Item", quantity: 1, unitPriceCents: 3000 });
      await desk.post(`/api/invoices/${inv.id}/issue`);
      invoices.push(inv.id);
    }
    const results = await Promise.all(invoices.map((id) => desk.post(`/api/invoices/${id}/apply-credit`, { amountCents: 3000 })));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    for (const r of results) expect(r.statusCode).toBeLessThan(500);
    expect((await desk.get(`/api/customers/${first.customerId}/credits`)).json().balanceCents).toBe(0);
  });

  it("double-clicked refunds refund once", async () => {
    const { invoiceId } = await issuedInvoice(4000);
    await desk.post(`/api/invoices/${invoiceId}/payments`, { amountCents: 4000, method: "card" });
    await manager.post(`/api/invoices/${invoiceId}/credit-notes`, { amountCents: 1000, reason: "x" });
    const results = await Promise.all([1, 2].map(() => manager.post(`/api/invoices/${invoiceId}/refunds`, { amountCents: 1000, method: "card", reason: "dbl" })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await desk.get(`/api/invoices/${invoiceId}`)).json()).toMatchObject({ refundsCents: 1000, balanceCents: 0 });
  });

  it("issuing many drafts at once gives unique, gap-free invoice numbers", async () => {
    const c = (await desk.post("/api/customers", { firstName: "Num", lastName: "Bers" })).json();
    const drafts = [];
    for (let i = 0; i < 8; i++) {
      const d = (await desk.post("/api/invoices", { customerId: c.id, locationId: org.locationId })).json();
      await desk.post(`/api/invoices/${d.id}/lines`, { description: "x", quantity: 1, unitPriceCents: 100 });
      drafts.push(d.id);
    }
    const results = await Promise.all(drafts.map((id) => desk.post(`/api/invoices/${id}/issue`)));
    const numbers = results.map((r) => r.json().number).sort((a: number, b: number) => a - b);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[7] - numbers[0]).toBe(7);
    const max = await ctx.ownerDb.selectFrom("invoices").select((eb) => eb.fn.max("number").as("m")).where("organizationId", "=", org.orgId).executeTakeFirstOrThrow();
    const count = await ctx.ownerDb.selectFrom("invoices").select((eb) => eb.fn.countAll<number>().as("n")).where("organizationId", "=", org.orgId).where("number", "is not", null).executeTakeFirstOrThrow();
    expect(Number(max.m)).toBe(Number(count.n));
  });

  it("two bookings racing for the last space: one gets it", async () => {
    await owner.put(`/api/locations/${org.locationId}/capacity`, { daycare: 1, boarding: null });
    const svc = (await manager.post("/api/services", { name: "Race Daycare", category: "daycare", priceCents: 100, priceUnit: "per_day" })).json();
    const c = (await desk.post("/api/customers", { firstName: "Cap", lastName: "Race" })).json();
    const pets = await Promise.all([1, 2, 3].map((n) => desk.post("/api/pets", { customerId: c.id, name: `Dog${n}`, species: "dog" }).then((r) => r.json())));
    const results = await Promise.all(pets.map((p) => desk.post("/api/reservations", {
      customerId: c.id, locationId: org.locationId, serviceId: svc.id, petIds: [p.id],
      startsAt: "2027-03-01T13:00:00Z", endsAt: "2027-03-01T21:00:00Z",
    })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
  });

  it("the same pet booked twice at once: one booking", async () => {
    const svc = (await manager.post("/api/services", { name: "Race Boarding", category: "boarding", priceCents: 100, priceUnit: "per_night" })).json();
    const c = (await desk.post("/api/customers", { firstName: "Pet", lastName: "Race" })).json();
    const pet = (await desk.post("/api/pets", { customerId: c.id, name: "Twin", species: "dog" })).json();
    const results = await Promise.all([1, 2].map(() => desk.post("/api/reservations", {
      customerId: c.id, locationId: org.locationId, serviceId: svc.id, petIds: [pet.id],
      startsAt: "2027-04-01T18:00:00Z", endsAt: "2027-04-02T15:00:00Z",
    })));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });
});
