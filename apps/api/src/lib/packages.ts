import { percentOf, type StayPrice } from "@pawguild/shared";
import { sql } from "kysely";
import type { Tx } from "../db";
import type { AuthContext } from "./auth-context";

export interface PackageBalance {
  id: string; productId: string; name: string; covers: "full_day" | "half_day"; days: number; used: number; remaining: number;
  priceCents: number; purchasedAt: Date; expiresOn: string | null; invoiceId: string; invoiceStatus: string;
  status: "active" | "used_up" | "expired" | "void";
}

/** A customer's packages with what's left on each. Redemptions on void invoices don't count. */
export async function packageBalances(trx: Tx, customerId: string, today: string, lock = false): Promise<PackageBalance[]> {
  // Serializes spending a customer's package days (packages are insert-only, so no row locks).
  if (lock) await sql`select pg_advisory_xact_lock(hashtextextended(${`packages:${customerId}`}, 0))`.execute(trx);
  const rows = await sql<Omit<PackageBalance, "remaining" | "status"> & { used: number }>`
    select cp.id, cp.product_id, cp.name, cp.covers, cp.days, cp.price_cents::int as price_cents, cp.purchased_at,
           cp.expires_on::text as expires_on, cp.invoice_id, i.status as invoice_status,
           (select count(*) from package_redemptions r join invoices ri on ri.id = r.invoice_id
             where r.customer_package_id = cp.id and ri.status <> 'void')::int as used
      from customer_packages cp join invoices i on i.id = cp.invoice_id
     where cp.customer_id = ${customerId}
     order by cp.expires_on nulls last, cp.purchased_at, cp.id`.execute(trx);
  return rows.rows.map((r) => {
    const remaining = Math.max(0, r.days - r.used);
    const status = r.invoiceStatus === "void" ? "void" : remaining === 0 ? "used_up" : r.expiresOn && r.expiresOn < today ? "expired" : "active";
    return { ...r, covers: r.covers as PackageBalance["covers"], remaining, status };
  });
}

/**
 * Write a priced stay onto a draft invoice. Daycare days (full or half) are paid from the
 * customer's packages first (soonest-expiring first, only on days before each package expires);
 * those days go on their own $0 "prepaid" line with a redemption per day. The rest is charged.
 */
export async function writeStayLines(trx: Tx, auth: AuthContext, args: {
  invoiceId: string; reservationId: string; customerId: string; petNames: string[]; priced: StayPrice & { taxable: Map<string, boolean> };
  additionalPetDiscountBps: number; today: string;
  /** false: charge everything, even if the customer has packages. */
  usePackages?: boolean;
}) {
  const { invoiceId, priced, petNames } = args;
  const names = petNames.join(", ");
  const pets = Math.max(1, petNames.length);
  const needsPackages = args.usePackages !== false && priced.lines.some((l) => (l.kind === "daycare_full" || l.kind === "daycare_half") && l.dates);
  // Locked so two invoices for the same customer can't spend the same package days.
  const packages = needsPackages ? (await packageBalances(trx, args.customerId, args.today, true)).filter((p) => p.status === "active") : [];
  const left = new Map(packages.map((p) => [p.id, p.remaining]));
  let position = 0;
  const insertLine = async (values: { serviceId: string | null; description: string; quantity: number; unitPriceCents: number; discountCents: number; taxable: boolean }) =>
    (await trx.insertInto("invoiceLines").values({ organizationId: auth.orgId, invoiceId, position: position++, stayLine: true, ...values })
      .returning("id").executeTakeFirstOrThrow()).id;

  for (const line of priced.lines) {
    const covers = line.kind === "daycare_full" ? "full_day" : line.kind === "daycare_half" ? "half_day" : null;
    // One unit per pet per day.
    const units = covers && line.dates ? line.dates.flatMap((d) => Array.from({ length: pets }, () => d)) : [];
    const used = new Map<string, string[]>();
    for (const date of units) {
      const pkg = packages.find((p) => p.covers === covers && (left.get(p.id) ?? 0) > 0 && (!p.expiresOn || date <= p.expiresOn));
      if (!pkg) continue;
      left.set(pkg.id, left.get(pkg.id)! - 1);
      used.set(pkg.id, [...(used.get(pkg.id) ?? []), date]);
    }
    const redeemed = [...used.values()].reduce((n, d) => n + d.length, 0);
    const quantity = line.units * line.petCount - redeemed;
    const petsText = pets > 1 ? ` × ${pets} pets` : "";
    if (quantity > 0) {
      // The additional-pet discount stays on the additional pets' days that are still charged.
      const discountCents = redeemed === 0 ? line.discountCents
        : line.discountCents === 0 ? 0 : percentOf(line.unitPriceCents * Math.min(quantity, line.units * (line.petCount - 1)), args.additionalPetDiscountBps);
      await insertLine({
        serviceId: line.serviceId, taxable: priced.taxable.get(line.serviceId) ?? false, unitPriceCents: line.unitPriceCents, discountCents, quantity,
        description: redeemed === 0 ? `${line.label} — ${names} (${line.unitsText}${petsText})` : `${line.label} — ${names} (${quantity} charged${petsText ? " across pets" : ""})`,
      });
    }
    for (const [pkgId, dates] of used) {
      const pkg = packages.find((p) => p.id === pkgId)!;
      const lineId = await insertLine({
        serviceId: line.serviceId, taxable: false, unitPriceCents: 0, discountCents: 0, quantity: dates.length,
        description: `${line.label} — ${names} (${dates.length} day${dates.length === 1 ? "" : "s"} prepaid: ${pkg.name})`,
      });
      await trx.insertInto("packageRedemptions").values(dates.map((usedOn) => ({
        organizationId: auth.orgId, customerPackageId: pkgId, invoiceId, invoiceLineId: lineId, reservationId: args.reservationId, usedOn,
      }))).execute();
    }
  }
}
