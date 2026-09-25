/**
 * Vaccination requirements. A required vaccine must be on file and valid through the last day
 * of the stay. Names are matched case-insensitively ("rabies" satisfies "Rabies").
 */
export type VaccineState = "current" | "missing" | "expired" | "expires_during_stay";

export interface VaccineCheck {
  vaccine: string;
  state: VaccineState;
  /** Latest expiry on file for this vaccine, if any. */
  expiresOn: string | null;
}

export const VACCINE_STATE_LABELS: Record<VaccineState, string> = {
  current: "Current",
  missing: "Not on file",
  expired: "Expired",
  expires_during_stay: "Expires during stay",
};

export const normalizeVaccine = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * @param required  vaccine names required for this pet's species on this service
 * @param records   the pet's non-voided vaccination records
 * @param firstDay  first local date of the stay (YYYY-MM-DD)
 * @param lastDay   last local date of the stay (YYYY-MM-DD)
 */
export function checkVaccinations(
  required: readonly string[],
  records: readonly { vaccine: string; expiresOn: string }[],
  firstDay: string,
  lastDay: string,
): VaccineCheck[] {
  const latest = new Map<string, string>();
  for (const r of records) {
    const key = normalizeVaccine(r.vaccine);
    const prev = latest.get(key);
    if (!prev || r.expiresOn > prev) latest.set(key, r.expiresOn);
  }
  return required.map((vaccine) => {
    const expiresOn = latest.get(normalizeVaccine(vaccine)) ?? null;
    const state: VaccineState =
      expiresOn === null ? "missing"
        : expiresOn < firstDay ? "expired"
        : expiresOn < lastDay ? "expires_during_stay"
        : "current";
    return { vaccine, state, expiresOn };
  });
}

export const vaccinationsOk = (checks: readonly VaccineCheck[]) => checks.every((c) => c.state === "current");
