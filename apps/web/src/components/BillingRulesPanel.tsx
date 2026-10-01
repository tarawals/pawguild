import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addDays, BOARDING_MODE_LABELS, BOARDING_MODES, formatBps, formatMoney, parsePercentToBps, priceStay, zonedDateTime,
  type BillingRules, type PricedService, type PriceUnit,
} from "@pawguild/shared";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, get, put, type Service } from "../api";
import { useCan, useMe } from "../auth";
import { ErrorAlert, fieldErrors, Loading, Panel, SelectField, TextField } from "./ui";
import { toLocalInput } from "../units";

type Form = Omit<BillingRules, "halfDayMaxHours" | "gracePeriodMinutes" | "additionalPetDiscountBps"> & {
  halfDayMaxHours: string; gracePeriodMinutes: string; additionalPetDiscount: string;
};
const toForm = (r: BillingRules): Form => ({
  ...r, halfDayMaxHours: String(r.halfDayMaxHours), gracePeriodMinutes: String(r.gracePeriodMinutes),
  additionalPetDiscount: formatBps(r.additionalPetDiscountBps).replace("%", ""),
});

/** Parse the form; throws field errors like the server does. */
function toRules(f: Form): BillingRules {
  const fields: { path: string; message: string }[] = [];
  const hours = Number(f.halfDayMaxHours), grace = Number(f.gracePeriodMinutes);
  let bps = 0;
  if (!Number.isFinite(hours) || f.halfDayMaxHours.trim() === "") fields.push({ path: "halfDayMaxHours", message: "Enter a number of hours, like 5" });
  if (!Number.isInteger(grace)) fields.push({ path: "gracePeriodMinutes", message: "Enter whole minutes, like 30" });
  try { bps = parsePercentToBps(f.additionalPetDiscount || "0"); } catch (e) { fields.push({ path: "additionalPetDiscountBps", message: (e as Error).message }); }
  if (fields.length) throw new ApiError(400, "validation_failed", "Some fields need attention.", fields);
  return { ...f, halfDayMaxHours: hours, gracePeriodMinutes: grace, additionalPetDiscountBps: bps };
}

const priced = (s: Service | undefined): PricedService | null =>
  s ? { id: s.id, name: s.name, category: s.category, priceUnit: s.priceUnit as PriceUnit, priceCents: s.priceCents } : null;

/** A few sample stays priced under the rules being edited, so owners can see the effect before saving. */
function Examples({ rules, services, timeZone }: { rules: BillingRules; services: Service[]; timeZone: string }) {
  const boarding = services.find((s) => s.isActive && s.category === "boarding" && s.priceUnit === "per_night");
  const full = services.find((s) => s.id === rules.daycareFullServiceId);
  const half = services.find((s) => s.id === rules.daycareHalfServiceId);
  // A sample Friday in the coming weeks.
  const today = toLocalInput(new Date()).slice(0, 10);
  let fri = today;
  while (new Date(`${fri}T12:00:00Z`).getUTCDay() !== 5) fri = addDays(fri, 1);
  const at = (offset: number, time: string) => zonedDateTime(addDays(fri, offset), time, timeZone);
  const samples: { label: string; service?: Service; from: Date; to: Date; pets?: number }[] = [
    { label: "Boarding, Friday 2 PM to Sunday 11 AM", service: boarding, from: at(0, "14:00"), to: at(2, "11:00") },
    { label: "Boarding, Friday 2 PM to Sunday 5 PM (late pick-up)", service: boarding, from: at(0, "14:00"), to: at(2, "17:00") },
    ...(rules.additionalPetDiscountBps > 0 ? [{ label: "Two dogs boarding, Friday 2 PM to Sunday 11 AM", service: boarding, from: at(0, "14:00"), to: at(2, "11:00"), pets: 2 }] : []),
    { label: "Daycare, 8 AM to 12:30 PM", service: full, from: at(3, "08:00"), to: at(3, "12:30") },
    { label: "Daycare, 8 AM to 5:30 PM", service: full, from: at(3, "08:00"), to: at(3, "17:30") },
  ];
  return (
    <div className="stack" style={{ gap: 6 }} aria-live="polite">
      <h3 style={{ margin: 0, fontSize: "1rem" }}>How these rules would charge</h3>
      <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Examples">
        {samples.map((x) => {
          if (!x.service) return <li key={x.label} className="muted">{x.label}: {x.label.startsWith("Daycare") ? "choose the full-day daycare service to see this" : "add a boarding service priced per night to see this"}</li>;
          const p = priceStay({ rules, service: priced(x.service)!, daycareFull: priced(full), daycareHalf: priced(half), startsAt: x.from, endsAt: x.to, petCount: x.pets ?? 1, timeZone });
          return (
            <li key={x.label}>
              <strong>{x.label}:</strong> {p.lines.map((l) => `${l.description}${l.petCount > 1 ? ` × ${l.petCount} pets` : ""}${l.discountCents ? ` (−${formatMoney(l.discountCents)})` : ""}`).join(" + ")} = <strong>{formatMoney(p.totalCents)}</strong>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function BillingRulesPanel() {
  const qc = useQueryClient();
  const me = useMe();
  const canManage = useCan("settings:manage");
  const rules = useQuery({ queryKey: ["settings", "billing"], queryFn: () => get<BillingRules>("/api/settings/billing") });
  const services = useQuery({ queryKey: ["services"], queryFn: () => get<{ items: Service[] }>("/api/services") });
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (rules.data) setForm(toForm(rules.data)); }, [rules.data]);
  const save = useMutation({
    mutationFn: () => put<BillingRules>("/api/settings/billing", toRules(form!)),
    onSuccess: () => { setSaved(true); qc.invalidateQueries({ queryKey: ["settings", "billing"] }); qc.invalidateQueries({ queryKey: ["reservation"] }); },
  });
  if (rules.isPending || services.isPending || !form) return <Panel title="Billing rules"><Loading /></Panel>;
  const err = fieldErrors(save.error);
  const daycare = (services.data?.items ?? []).filter((s) => s.category === "daycare" && s.priceUnit === "per_day");
  const set = (patch: Partial<Form>) => { setSaved(false); setForm({ ...form, ...patch }); };
  let preview: BillingRules | null = null;
  try { preview = toRules(form); } catch { preview = null; }
  function onSubmit(e: FormEvent) { e.preventDefault(); setSaved(false); save.mutate(); }

  return (
    <Panel title="Billing rules">
      <form onSubmit={onSubmit} noValidate className="stack" aria-label="Billing rules">
        <p className="muted" style={{ margin: 0 }}>
          How stays are charged on estimates and on invoices created from reservations. Invoices already created aren't changed.
        </p>
        <ErrorAlert error={save.error} />
        <fieldset disabled={!canManage}>
          <legend>Boarding</legend>
          <div className="form-grid">
            <SelectField label="Boarding is charged" value={form.boardingMode} onChange={(e) => set({ boardingMode: e.target.value as Form["boardingMode"] })} error={err("boardingMode")}
              hint={form.boardingMode === "nights_plus_daycare" ? "Each day's time within the daytime hours is charged as a half or full day of daycare."
                : form.boardingMode === "per_24_hours" ? "Counted in 24-hour periods from drop-off." : "Daytime care is included in the nightly rate."}>
              {BOARDING_MODES.map((m) => <option key={m} value={m}>{BOARDING_MODE_LABELS[m]}</option>)}
            </SelectField>
            {form.boardingMode === "per_24_hours" && (
              <SelectField label="Time past the last full 24 hours" value={form.boardingExtraTime} onChange={(e) => set({ boardingExtraTime: e.target.value as Form["boardingExtraTime"] })}
                hint="After the grace period.">
                <option value="daycare">Charge daycare (half or full day)</option>
                <option value="extra_night">Charge another 24 hours</option>
              </SelectField>
            )}
            {form.boardingMode === "nights_plus_daycare" && <>
              <TextField label="Daytime starts" type="time" value={form.daytimeStart} onChange={(e) => set({ daytimeStart: e.target.value })} error={err("daytimeStart")} />
              <TextField label="Daytime ends" type="time" value={form.daytimeEnd} onChange={(e) => set({ daytimeEnd: e.target.value })} error={err("daytimeEnd")} />
            </>}
          </div>
        </fieldset>
        <fieldset disabled={!canManage}>
          <legend>Daycare</legend>
          <div className="form-grid">
            <SelectField label="Full-day daycare service" value={form.daycareFullServiceId ?? ""} onChange={(e) => set({ daycareFullServiceId: e.target.value || null })} error={err("daycareFullServiceId")}>
              <option value="">None</option>
              {daycare.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatMoney(s.priceCents)}</option>)}
            </SelectField>
            <SelectField label="Half-day daycare service" value={form.daycareHalfServiceId ?? ""} onChange={(e) => set({ daycareHalfServiceId: e.target.value || null })} error={err("daycareHalfServiceId")}
              hint="Without one, short days are charged as full days.">
              <option value="">None</option>
              {daycare.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatMoney(s.priceCents)}</option>)}
            </SelectField>
            <TextField label="Half day is up to (hours)" inputMode="decimal" value={form.halfDayMaxHours} onChange={(e) => set({ halfDayMaxHours: e.target.value })} error={err("halfDayMaxHours")}
              hint="Longer than this (plus the grace period) is a full day. Typically 5." />
            <TextField label="Grace period (minutes)" inputMode="numeric" value={form.gracePeriodMinutes} onChange={(e) => set({ gracePeriodMinutes: e.target.value })} error={err("gracePeriodMinutes")}
              hint="How late a pick-up can be before extra time is charged." />
          </div>
        </fieldset>
        <fieldset disabled={!canManage}>
          <legend>More than one pet</legend>
          <div className="form-grid">
            <TextField label="Discount for each additional pet (%)" inputMode="decimal" value={form.additionalPetDiscount} onChange={(e) => set({ additionalPetDiscount: e.target.value })}
              error={err("additionalPetDiscountBps")} hint="On boarding and daycare when pets share a reservation. 0 for none." />
          </div>
        </fieldset>
        {preview && <Examples rules={preview} services={services.data?.items ?? []} timeZone={me.organization.timezone} />}
        {canManage && (
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={save.isPending}>Save billing rules</button>
            {saved && <span role="status" className="muted" style={{ alignSelf: "center" }}>Saved. New estimates and invoices use these rules.</span>}
          </div>
        )}
      </form>
    </Panel>
  );
}
