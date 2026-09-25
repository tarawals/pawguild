/** Care record vocabulary shared by API and web. */
export const CARE_KINDS = ["feeding", "medication", "potty", "walk", "play", "rest", "grooming", "note"] as const;
export type CareKind = (typeof CARE_KINDS)[number];
export const CARE_KIND_LABELS: Record<CareKind, string> = {
  feeding: "Fed", medication: "Medication", potty: "Potty", walk: "Walk", play: "Play", rest: "Rest", grooming: "Grooming", note: "Note",
};

export const MEALS = ["breakfast", "lunch", "dinner", "snack"] as const;
export const AMOUNTS_EATEN = ["all", "most", "some", "none"] as const;
export const AMOUNT_EATEN_LABELS: Record<(typeof AMOUNTS_EATEN)[number], string> = {
  all: "Ate all", most: "Ate most", some: "Ate some", none: "Didn't eat",
};
export const MEDICATION_STATUSES = ["given", "refused", "skipped"] as const;
export const MEDICATION_STATUS_LABELS: Record<(typeof MEDICATION_STATUSES)[number], string> = {
  given: "Given", refused: "Refused", skipped: "Skipped",
};

export const INCIDENT_CATEGORIES = ["injury", "illness", "behavior", "altercation", "escape", "property", "other"] as const;
export const INCIDENT_CATEGORY_LABELS: Record<(typeof INCIDENT_CATEGORIES)[number], string> = {
  injury: "Injury", illness: "Illness", behavior: "Behavior", altercation: "Altercation with another pet",
  escape: "Escape attempt", property: "Property damage", other: "Other",
};
export const INCIDENT_SEVERITIES = ["low", "medium", "high"] as const;

/** Parse "8:00, 18:30" into sorted, de-duplicated "HH:MM" strings; throws on invalid input. */
export function parseTimesOfDay(input: string): string[] {
  const out = new Set<string>();
  for (const raw of input.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(raw);
    if (!m) throw new RangeError(`"${raw}" isn't a time like 08:00 or 6:30 pm`);
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ampm = m[3]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) throw new RangeError(`"${raw}" isn't a valid time`);
      h = (h % 12) + (ampm === "pm" ? 12 : 0);
    }
    if (h > 23 || min > 59) throw new RangeError(`"${raw}" isn't a valid time`);
    out.add(`${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`);
  }
  return [...out].sort();
}
