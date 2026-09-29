import { useMutation, useQueryClient } from "@tanstack/react-query";
import { summarizeHours, WEEKDAY_LABELS } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { ApiError, del, patch, post, put, type Location } from "../api";
import { useCan, useMe } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, SelectField, TextField } from "./ui";
import { formatDate } from "../units";

const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf("timeZone"); } catch { return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]; }
})();

type DetailsForm = Record<"name" | "addressLine1" | "addressLine2" | "city" | "region" | "postalCode" | "country" | "phone" | "email" | "timezone", string>;
const toForm = (l?: Location): DetailsForm => ({
  name: l?.name ?? "", addressLine1: l?.addressLine1 ?? "", addressLine2: l?.addressLine2 ?? "", city: l?.city ?? "",
  region: l?.region ?? "", postalCode: l?.postalCode ?? "", country: l?.country ?? "", phone: l?.phone ?? "", email: l?.email ?? "",
  timezone: l?.timezone ?? "",
});

/** Add a location (no `location`) or edit one. */
export function LocationDetailsForm({ location, onDone }: { location?: Location; onDone: (saved?: Location) => void }) {
  const qc = useQueryClient();
  const me = useMe();
  const [form, setForm] = useState(toForm(location));
  const save = useMutation({
    mutationFn: () => (location ? patch<Location>(`/api/locations/${location.id}`, form) : post<Location>("/api/locations", form)),
    onSuccess: (saved) => { qc.invalidateQueries({ queryKey: ["locations"] }); onDone(saved); },
  });
  const err = fieldErrors(save.error);
  const field = (key: keyof DetailsForm, label: string, extra: object = {}) => (
    <TextField label={label} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} error={err(key)} {...extra} />
  );
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={location ? `Details for ${location.name}` : "New location"}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        {field("name", "Location name", { required: true })}
        {field("phone", "Phone", { type: "tel" })}
        {field("email", "Email", { type: "email" })}
        <SelectField label="Time zone" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} error={err("timezone")}
          hint="Used for business hours, billing days and nights, and daily care.">
          <option value="">Same as the business ({me.organization.timezone})</option>
          {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
        </SelectField>
        {field("addressLine1", "Address")}
        {field("addressLine2", "Address line 2")}
        {field("city", "City")}
        {field("region", "State / region")}
        {field("postalCode", "Postal code")}
        {field("country", "Country", { hint: "Two letters, e.g. US", maxLength: 2 })}
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{location ? "Save details" : "Add location"}</button>
        <button className="btn" type="button" onClick={() => onDone()}>Cancel</button>
      </div>
    </form>
  );
}

export function LocationDetails({ location }: { location: Location }) {
  const canManage = useCan("locations:manage");
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const toggle = useMutation({
    mutationFn: () => patch<Location>(`/api/locations/${location.id}`, { isActive: !location.isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["locations"] }),
  });
  if (editing) return <LocationDetailsForm location={location} onDone={() => setEditing(false)} />;
  const address = [location.addressLine1, location.addressLine2, [location.city, location.region, location.postalCode].filter(Boolean).join(" "), location.country]
    .filter(Boolean).join(", ");
  return (
    <div className="stack">
      <ErrorAlert error={toggle.error} />
      <dl className="details">
        <dt>Status</dt><dd>{location.isActive ? <span className="badge badge-success">Active</span> : <span className="badge">Inactive — can't take bookings</span>}</dd>
        <dt>Address</dt><dd>{address || "—"}</dd>
        <dt>Phone</dt><dd>{location.phone ?? "—"}</dd>
        <dt>Email</dt><dd>{location.email ?? "—"}</dd>
        <dt>Time zone</dt><dd>{location.effectiveTimezone.replace(/_/g, " ")}{!location.timezone && <span className="muted"> (the business's)</span>}</dd>
      </dl>
      {canManage && (
        <div className="actions">
          <button className="btn" onClick={() => setEditing(true)}>Edit details</button>
          <button className={`btn ${location.isActive ? "btn-danger" : ""}`} disabled={toggle.isPending} onClick={() => {
            if (!location.isActive || window.confirm(`Deactivate ${location.name}? It stops taking bookings. Its history, kennels and settings are kept, and it can be reactivated.`)) toggle.mutate();
          }}>{location.isActive ? "Deactivate location" : "Reactivate location"}</button>
        </div>
      )}
    </div>
  );
}

type DayRow = { open: boolean; opensAt: string; closesAt: string };
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function HoursForm({ location }: { location: Location }) {
  const canManage = useCan("locations:manage");
  const qc = useQueryClient();
  const initial = () => Object.fromEntries(DISPLAY_ORDER.map((w) => {
    const h = location.hours.find((x) => x.weekday === w);
    return [w, { open: Boolean(h), opensAt: h?.opensAt ?? "07:00", closesAt: h?.closesAt ?? "19:00" }];
  })) as Record<number, DayRow>;
  const [enforce, setEnforce] = useState(location.hours.length > 0);
  const [days, setDays] = useState(initial);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      const list = enforce ? DISPLAY_ORDER.filter((w) => days[w]!.open).map((w) => ({ weekday: w, opensAt: days[w]!.opensAt, closesAt: days[w]!.closesAt })) : [];
      if (enforce && list.length === 0) {
        throw new ApiError(400, "validation_failed", "Mark at least one day as open, or turn business hours off.", []);
      }
      return put(`/api/locations/${location.id}/hours`, { days: list });
    },
    onSuccess: () => { setSaved(true); qc.invalidateQueries({ queryKey: ["locations"] }); },
  });
  if (!canManage) return <p style={{ margin: 0 }}>{summarizeHours(location.hours)}{location.hours.length === 0 && " — bookings can be made for any time."}</p>;
  const err = fieldErrors(save.error);
  // Server paths are indexes into the submitted list (open days only, in display order).
  const openDays = DISPLAY_ORDER.filter((w) => days[w]!.open);
  const dayErr = (w: number, f: string) => err(`days.${openDays.indexOf(w)}.${f}`);
  const set = (w: number, patchRow: Partial<DayRow>) => { setSaved(false); setDays({ ...days, [w]: { ...days[w]!, ...patchRow } }); };
  function onSubmit(e: FormEvent) { e.preventDefault(); setSaved(false); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={`Business hours for ${location.name}`}>
      <ErrorAlert error={save.error} />
      <Checkbox label="Only allow drop-off and pick-up during business hours" checked={enforce} onChange={(e) => { setSaved(false); setEnforce(e.target.checked); }} />
      {enforce && (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Day</th><th scope="col">Open</th><th scope="col">Opens</th><th scope="col">Closes</th></tr></thead>
            <tbody>
              {DISPLAY_ORDER.map((w) => {
                const d = days[w]!; const name = WEEKDAY_LABELS[w];
                return (
                  <tr key={w}>
                    <td><strong>{name}</strong></td>
                    <td><input type="checkbox" style={{ width: 18, height: 18, minHeight: 18 }} aria-label={`Open on ${name}`} checked={d.open} onChange={(e) => set(w, { open: e.target.checked })} /></td>
                    <td>{d.open ? <input type="time" aria-label={`${name} opens`} value={d.opensAt} onChange={(e) => set(w, { opensAt: e.target.value })}
                      aria-invalid={Boolean(dayErr(w, "opensAt")) || undefined} /> : <span className="muted">Closed</span>}</td>
                    <td>{d.open && <>
                      <input type="time" aria-label={`${name} closes`} value={d.closesAt} onChange={(e) => set(w, { closesAt: e.target.value })}
                        aria-invalid={Boolean(dayErr(w, "closesAt")) || undefined} />
                      {dayErr(w, "closesAt") && <div style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{dayErr(w, "closesAt")}</div>}
                    </>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!enforce && <p className="muted" style={{ margin: 0 }}>Bookings can be made for any time. Closure days still apply.</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>Save hours</button>
        {saved && <span role="status" className="muted" style={{ alignSelf: "center" }}>Saved. Existing bookings aren't changed.</span>}
      </div>
    </form>
  );
}

export function ClosuresPanel({ location }: { location: Location }) {
  const canManage = useCan("locations:manage");
  const qc = useQueryClient();
  const [closedOn, setClosedOn] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => post<{ affectedReservations: number; closedOn: string }>(`/api/locations/${location.id}/closures`, { closedOn, reason }),
    onSuccess: (r) => {
      setClosedOn(""); setReason("");
      setNotice(r.affectedReservations > 0
        ? `Closed ${formatDate(r.closedOn)}. ${r.affectedReservations} existing booking${r.affectedReservations === 1 ? " drops off or picks up" : "s drop off or pick up"} that day — contact those customers or reschedule.`
        : `Closed ${formatDate(r.closedOn)}.`);
      qc.invalidateQueries({ queryKey: ["locations"] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/locations/${location.id}/closures/${id}`),
    onSuccess: () => { setNotice(null); qc.invalidateQueries({ queryKey: ["locations"] }); },
  });
  const err = fieldErrors(add.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); setNotice(null); add.mutate(); }
  return (
    <div className="stack">
      <ErrorAlert error={remove.error} />
      {notice && <div className="alert alert-warning" role="status" style={{ marginBottom: 0 }}>{notice}</div>}
      {location.closures.length === 0 ? <EmptyState title="No upcoming closures">Holidays and other closed days go here. No drop-offs or pick-ups can be booked on them.</EmptyState> : (
        <ul className="stack" style={{ listStyle: "none", margin: 0, padding: 0, gap: 8 }} aria-label={`Upcoming closures at ${location.name}`}>
          {location.closures.map((c) => (
            <li key={c.id} className="dose">
              <span><strong>{formatDate(c.closedOn)}</strong>{c.reason && <span className="muted"> — {c.reason}</span>}</span>
              {canManage && <button className="btn btn-small" aria-label={`Remove closure on ${formatDate(c.closedOn)}`} disabled={remove.isPending}
                onClick={() => { if (window.confirm(`Reopen ${formatDate(c.closedOn)}? Bookings will be allowed that day.`)) remove.mutate(c.id); }}>Remove</button>}
            </li>
          ))}
        </ul>
      )}
      {canManage && <ErrorAlert error={add.error} />}
      {canManage && (
        <form onSubmit={onSubmit} noValidate className="inline-form" aria-label={`Add closure at ${location.name}`} style={{ marginTop: 0 }}>
          <TextField label="Closed on" type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} error={err("closedOn")} />
          <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} error={err("reason")} placeholder="e.g. Thanksgiving" />
          <button className="btn" type="submit" disabled={add.isPending || !closedOn}>Add closure</button>
        </form>
      )}
    </div>
  );
}

