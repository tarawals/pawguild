import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, ROLE_LABELS, type Role } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { del, get, patch, post, type GroomingStaff, type Location, type Shift } from "../api";
import { useCan, useMe } from "../auth";
import { EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextField } from "../components/ui";
import { formatDate, formatTime, fromLocalInput, toLocalInput } from "../units";

const localDate = (d: Date) => toLocalInput(d).slice(0, 10);
function mondayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const day = new Date(y, m - 1, d, 12);
  return localDate(new Date(y, m - 1, d - ((day.getDay() + 6) % 7), 12));
}
const dayLabel = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
/** "9 AM–5 PM", "6:30–10 AM": short enough for a week grid. */
function compactRange(startIso: string, endIso: string) {
  const part = (iso: string) => {
    const d = new Date(iso); const h = d.getHours(), m = d.getMinutes();
    return { t: `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}`, ap: h < 12 ? "AM" : "PM" };
  };
  const a = part(startIso), b = part(endIso);
  return a.ap === b.ap ? `${a.t}–${b.t} ${b.ap}` : `${a.t} ${a.ap}–${b.t} ${b.ap}`;
}
const hours = (s: Shift) => (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 3_600_000;
const fmtHours = (h: number) => `${Math.round(h * 10) / 10}h`;

type Draft = { id?: string; membershipId: string; date: string; start: string; end: string; note: string; locationId: string };

function ShiftForm({ draft, staff, locations, onDone }: { draft: Draft; staff: GroomingStaff[]; locations: Location[]; onDone: (message?: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(draft);
  const overnight = form.start && form.end && form.end <= form.start;
  const body = () => {
    const startsAt = fromLocalInput(`${form.date}T${form.start}`);
    const endsAt = fromLocalInput(`${overnight ? addDays(form.date, 1) : form.date}T${form.end}`);
    return { membershipId: form.membershipId, locationId: form.locationId, startsAt, endsAt, note: form.note };
  };
  const save = useMutation({
    mutationFn: () => (form.id ? patch<Shift>(`/api/shifts/${form.id}`, body()) : post<Shift>("/api/shifts", body())),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ["shifts"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); qc.invalidateQueries({ queryKey: ["grooming"] });
      onDone(`Saved ${s.staffName}'s shift on ${formatDate(s.date)}.${s.warnings.length ? ` Note: ${s.warnings.join(". ")}.` : ""}`);
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/shifts/${form.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["shifts"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); onDone("Shift deleted."); },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={form.id ? "Edit shift" : "Add shift"}>
      <ErrorAlert error={save.error ?? remove.error} />
      <div className="form-grid">
        <SelectField label="Staff member" value={form.membershipId} onChange={(e) => setForm({ ...form, membershipId: e.target.value })} error={err("membershipId")}>
          <option value="">Choose…</option>
          {staff.map((s) => <option key={s.membershipId} value={s.membershipId}>{s.name} — {ROLE_LABELS[s.role as Role] ?? s.role}</option>)}
        </SelectField>
        {locations.length > 1 && (
          <SelectField label="Location" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })} error={err("locationId")}>
            {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </SelectField>
        )}
        <TextField label="Date" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} error={err("startsAt")} />
        <TextField label="Starts" type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
        <TextField label="Ends" type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} error={err("endsAt")}
          hint={overnight ? "Ends the next day (overnight shift)" : undefined} />
        <TextField label="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} error={err("note")} placeholder="e.g. Opening, grooming only" />
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending || !form.membershipId || !form.date || !form.start || !form.end}>
          {form.id ? "Save shift" : "Add shift"}
        </button>
        <button className="btn" type="button" onClick={() => onDone()}>Cancel</button>
        {form.id && <button className="btn btn-danger" type="button" disabled={remove.isPending}
          onClick={() => { if (window.confirm("Delete this shift? The change is kept in the history.")) remove.mutate(); }}>Delete shift</button>}
      </div>
    </form>
  );
}

export function SchedulePage() {
  const me = useMe();
  const canManage = useCan("schedules:manage");
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const week = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(params.get("week") ?? "") ? params.get("week")! : localDate(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations") });
  const locationId = params.get("location") ?? locations.data?.items[0]?.id ?? "";
  const set = (next: Record<string, string>) => { setMessage(null); setDraft(null); setParams({ week, ...(locationId && { location: locationId }), ...next }, { replace: true }); };
  const shifts = useQuery({
    queryKey: ["shifts", week, locationId],
    queryFn: () => get<{ items: Shift[] }>(`/api/shifts?from=${week}&to=${days[6]}&locationId=${locationId}`),
    enabled: Boolean(locationId), placeholderData: keepPreviousData,
  });
  const staff = useQuery({ queryKey: ["grooming", "staff"], queryFn: () => get<{ items: GroomingStaff[] }>("/api/grooming/staff") });
  const copy = useMutation({
    mutationFn: () => post<{ created: number; skipped: { staffName: string; date: string; reason: string }[] }>("/api/shifts/copy-week",
      { locationId, fromWeekStart: addDays(week, -7), toWeekStart: week }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["shifts"] }); qc.invalidateQueries({ queryKey: ["dashboard"] });
      setMessage(`Copied ${r.created} shift${r.created === 1 ? "" : "s"} from last week.` +
        (r.skipped.length ? ` Skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.staffName} on ${formatDate(s.date)} (${s.reason.replace(/\.$/, "")})`).join("; ")}.` : ""));
    },
  });

  const items = shifts.data?.items ?? [];
  const allStaff = staff.data?.items ?? [];
  // Managers see everyone so they can add shifts; others see who's scheduled.
  const people = [
    ...allStaff.filter((s) => canManage || items.some((i) => i.membershipId === s.membershipId)),
    ...[...new Map(items.filter((i) => !allStaff.some((s) => s.membershipId === i.membershipId))
      .map((i) => [i.membershipId, { membershipId: i.membershipId, name: `${i.staffName} (inactive)`, role: i.role, jobTitle: null }])).values()],
  ];
  const newDraft = (membershipId: string, date: string): Draft => ({ membershipId, date, start: "07:00", end: "15:00", note: "", locationId });
  const edit = (s: Shift): Draft => ({
    id: s.id, membershipId: s.membershipId, date: s.date, start: toLocalInput(s.startsAt).slice(11, 16), end: toLocalInput(s.endsAt).slice(11, 16),
    note: s.note ?? "", locationId: s.locationId,
  });

  return (
    <>
      <PageHeader title="Staff schedule" description={`Week of ${formatDate(week)}`}
        actions={canManage && <>
          <button className="btn" disabled={copy.isPending || !locationId} onClick={() => {
            if (window.confirm("Copy last week's shifts into this week? Shifts that would overlap existing ones are skipped.")) copy.mutate();
          }}>Copy last week</button>
          <button className="btn btn-primary" onClick={() => { setMessage(null); setDraft(newDraft("", days[0]!)); }}>Add shift</button>
        </>} />
      <div className="filters">
        <div className="actions" role="group" aria-label="Week">
          <button className="btn" onClick={() => set({ week: addDays(week, -7) })}>Previous week</button>
          <button className={`btn ${week === mondayOf(localDate(new Date())) ? "btn-primary" : ""}`} onClick={() => set({ week: mondayOf(localDate(new Date())) })}>This week</button>
          <button className="btn" onClick={() => set({ week: addDays(week, 7) })}>Next week</button>
        </div>
        {(locations.data?.items.length ?? 0) > 1 && (
          <SelectField label="Location" value={locationId} onChange={(e) => set({ location: e.target.value })}>
            {locations.data!.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </SelectField>
        )}
      </div>
      <ErrorAlert error={shifts.error ?? copy.error} />
      {message && <div className="alert alert-warning" role="status">{message}</div>}
      {draft && (
        <div style={{ marginBottom: 16 }}>
          <Panel title={draft.id ? "Edit shift" : "Add shift"}>
            <ShiftForm key={draft.id ?? `${draft.membershipId}-${draft.date}`} draft={draft} staff={allStaff} locations={locations.data?.items ?? []}
              onDone={(m) => { setDraft(null); if (m) setMessage(m); }} />
          </Panel>
        </div>
      )}
      {shifts.isPending || staff.isPending ? <Loading /> : people.length === 0 ? (
        <Panel><EmptyState title="No shifts this week">{canManage ? "Add shifts, or copy last week's." : "Nobody is scheduled yet."}</EmptyState></Panel>
      ) : (
        <Panel bodyless>
          <div className="table-wrap">
            <table className="schedule-grid">
              <caption className="visually-hidden">Shifts for the week of {formatDate(week)}</caption>
              <thead>
                <tr>
                  <th scope="col">Staff</th>
                  {days.map((d) => <th key={d} scope="col" style={{ minWidth: 90 }}>{dayLabel(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const mine = items.filter((i) => i.membershipId === p.membershipId);
                  return (
                    <tr key={p.membershipId}>
                      <th scope="row" style={{ textTransform: "none", letterSpacing: 0, fontSize: "0.95rem", color: "var(--text)", minWidth: 120 }}>
                        {p.name}{p.membershipId === me.membershipId && " (you)"}
                        <div className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
                          {ROLE_LABELS[p.role as Role] ?? p.role}{mine.length > 0 && ` · ${fmtHours(mine.reduce((n, s) => n + hours(s), 0))}`}
                        </div>
                      </th>
                      {days.map((d) => {
                        const cell = mine.filter((s) => s.date === d);
                        return (
                          <td key={d} style={{ verticalAlign: "top" }}>
                            <div className="stack" style={{ gap: 4 }}>
                              {cell.map((s) => {
                                const label = `${formatTime(s.startsAt)}–${formatTime(s.endsAt)}`;
                                const title = [s.note, ...s.warnings].filter(Boolean).join(". ");
                                return canManage ? (
                                  <button key={s.id} className={`btn btn-small ${s.warnings.length ? "" : "btn-primary"}`} title={title || undefined}
                                    aria-label={`Edit ${p.name}'s shift ${dayLabel(d)} ${label}${s.warnings.length ? " (outside business hours)" : ""}`}
                                    onClick={() => { setMessage(null); setDraft(edit(s)); }}>
                                    {compactRange(s.startsAt, s.endsAt)}{s.warnings.length > 0 && " ⚠"}
                                  </button>
                                ) : (
                                  <span key={s.id} className={`badge ${s.warnings.length ? "badge-warning" : "badge-success"}`} title={title || undefined} aria-label={label}>{compactRange(s.startsAt, s.endsAt)}</span>
                                );
                              })}
                              <ShiftNotes cell={cell} />
                              {canManage && (
                                <button className="btn btn-small" style={{ alignSelf: "flex-start" }} aria-label={`Add shift for ${p.name} on ${dayLabel(d)}`}
                                  onClick={() => { setMessage(null); setDraft(newDraft(p.membershipId, d)); }}>+</button>
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

/** Notes under a day's shifts (e.g. "Opening"). */
function ShiftNotes({ cell }: { cell: Shift[] }) {
  const notes = cell.map((s) => s.note).filter(Boolean);
  return notes.length ? <span className="muted" style={{ fontSize: "0.8rem" }}>{notes.join(" · ")}</span> : null;
}
