import {
  DEFAULT_BILLING_RULES, hhmm, priceStay, type BillingRules, type BoardingMode, type ExtraTimeRule, type PricedService,
  type PriceUnit, type StayPrice,
} from "@pawguild/shared";
import type { Tx } from "../db";

export async function getBillingRules(trx: Tx, orgId: string): Promise<BillingRules> {
  const row = await trx.selectFrom("billingSettings").selectAll().where("organizationId", "=", orgId).executeTakeFirst();
  if (!row) return DEFAULT_BILLING_RULES;
  return {
    boardingMode: row.boardingMode as BoardingMode,
    boardingExtraTime: row.boardingExtraTime as ExtraTimeRule,
    halfDayMaxHours: row.halfDayMaxMinutes / 60,
    gracePeriodMinutes: row.gracePeriodMinutes,
    daytimeStart: hhmm(row.daytimeStart),
    daytimeEnd: hhmm(row.daytimeEnd),
    daycareFullServiceId: row.daycareFullServiceId,
    daycareHalfServiceId: row.daycareHalfServiceId,
    additionalPetDiscountBps: row.additionalPetDiscountBps,
  };
}

async function service(trx: Tx, id: string | null): Promise<(PricedService & { isTaxable: boolean }) | null> {
  if (!id) return null;
  const s = await trx.selectFrom("services").select(["id", "name", "category", "priceUnit", "priceCents", "isTaxable"]).where("id", "=", id).executeTakeFirst();
  return s ? { ...s, priceUnit: s.priceUnit as PriceUnit } : null;
}

/** Price a reservation under the current billing rules, with the booked service at its locked-in rate. */
export async function priceReservation(trx: Tx, orgId: string, r: {
  serviceId: string; unitPriceCents: number; priceUnit: string; startsAt: Date; endsAt: Date; petCount: number; timeZone: string;
}): Promise<StayPrice & { taxable: Map<string, boolean> }> {
  const rules = await getBillingRules(trx, orgId);
  const [booked, full, half] = await Promise.all([service(trx, r.serviceId), service(trx, rules.daycareFullServiceId), service(trx, rules.daycareHalfServiceId)]);
  if (!booked) throw new Error("reservation service missing");
  const price = priceStay({
    rules, service: { ...booked, priceUnit: r.priceUnit as PriceUnit, priceCents: r.unitPriceCents },
    daycareFull: full, daycareHalf: half, startsAt: r.startsAt, endsAt: r.endsAt, petCount: Math.max(1, r.petCount), timeZone: r.timeZone,
  });
  const taxable = new Map([booked, full, half].filter(Boolean).map((s) => [s!.id, s!.isTaxable]));
  return { ...price, taxable };
}
