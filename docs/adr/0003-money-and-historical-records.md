# ADR 0003 — Money and historical records

Status: accepted (2026-09-25)

## Money

- Money is an **integer number of minor units (cents)**, stored as `bigint` and exchanged as
  JSON integers. Floats are never used for money.
- `packages/shared/src/money.ts` provides `parseMoney` (string → cents without float math),
  `formatMoney`, `sumCents`, and `percentOf` (basis points, rounded half away from zero) for
  tax and percentage discounts.
- Each organization has one `currency`. Multi-currency is out of scope.

## Historical records

- Business records are **archived** (`archived_at`), not deleted. The application role has no
  DELETE privilege on them.
- Records that document something that happened (vaccinations now; care logs, medication and
  financial entries later) are **immutable**. Corrections use a void or reversal entry
  (`voided_at`, `voided_by_user_id`, or future refund and credit rows) so history is kept.
- Every create, update, archive and void writes an `audit_log` row in the same transaction.
  The app role can only INSERT and SELECT audit rows.
