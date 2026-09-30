import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { get, put, type GroomingAppointment, type GroomingSchedule, type GroomingStaff, type Location } from "../api";
import { useCan, useMe } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, Loading, PageHeader, Panel, ReservationStatusBadge, SelectField, TextField } from "../components/ui";
import { formatDate, formatTime, toLocalInput } from "../units";

const ASSIGNABLE = ["pending", "confirmed", "checked_in"];
const today = () => toLocalInput(new Date()).slice(0, 10);
function shift(date: string, days: number) {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return toLocalInput(new Date(y, m - 1, d + days, 12)).slice(0, 10);
}

function GroomerSelect({ appointment, staff, label }: { appointment: GroomingAppointment; staff: GroomingStaff[]; label: string }) {
  const qc = useQueryClient();
  const assign = useMutation({
    mutationFn: (membershipId: string | null) => put(`/api/grooming/appointments/${appointment.id}/groomer`, { membershipId }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ["grooming"] }); qc.invalidateQueries({ queryKey: ["reservation", appointment.id] }); },
  });
  const groomers = staff.filter((s) => s.role === "groomer"), others = staff.filter((s) => s.role !== "groomer");
  return (
    <div className="stack" style={{ gap: 6 }}>
      <ErrorAlert error={assign.error} />
      <SelectField label={label} value={appointment.groomerMembershipId ?? ""} disabled={assign.isPending}
        onChange={(e) => assign.mutate(e.target.value || null)}>
        <option value="">Not assigned</option>
        {appointment.groomerMembershipId && !staff.some((s) => s.membershipId === appointment.groomerMembershipId) &&
          <option value={appointment.groomerMembershipId}>(inactive staff member)</option>}
        {groomers.length > 0 && <optgroup label="Groomers">{groomers.map((s) => <option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}</optgroup>}
        {others.length > 0 && <optgroup label="Other staff">{others.map((s) => <option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}</optgroup>}
      </SelectField>
    </div>
  );
}

function AppointmentCard({ a, staff, canAssign, outsideShift }: { a: GroomingAppointment; staff: GroomingStaff[]; canAssign: boolean; outsideShift?: string }) {
  const pets = a.pets.map((p) => p.name).join(", ");
  const stations = [...new Set(a.pets.map((p) => p.resourceName).filter(Boolean))];
  return (
    <li className="dose" style={{ display: "block", padding: "10px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>{formatTime(a.startsAt)}–{formatTime(a.endsAt)}</strong>
        <ReservationStatusBadge status={a.status} />
      </div>
      <div><Link to={`/reservations/${a.id}`}>{a.pets.map((p) => `${p.name}${p.breed ? ` (${p.breed})` : ""}`).join(", ")}</Link> · {a.serviceName}</div>
      <div className="muted">
        <Link to={`/customers/${a.customerId}`}>{a.customerName}</Link>
        {" · "}{stations.length ? stations.join(", ") : "No station assigned"}
      </div>
      {a.notes && <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{a.notes}</div>}
      {outsideShift && <div><span className="badge badge-warning">{outsideShift}</span></div>}
      {canAssign && ASSIGNABLE.includes(a.status) && (
        <div style={{ marginTop: 8 }}><GroomerSelect appointment={a} staff={staff} label={`Groomer for ${pets} at ${formatTime(a.startsAt)}`} /></div>
      )}
    </li>
  );
}

export function GroomingPage() {
  const me = useMe();
  const canBook = useCan("reservations:write");
  const canCheckIn = useCan("stays:check_in_out");
  const canAssign = canBook || canCheckIn;
  const [params, setParams] = useSearchParams();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today();
  const locationId = params.get("location") ?? "";
  const mine = params.get("mine") === "1";
  const set = (next: Record<string, string>) => {
    const merged = { date, ...(locationId && { location: locationId }), ...(mine && { mine: "1" }), ...next };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, v]) => v)), { replace: true });
  };
  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations") });
  const schedule = useQuery({
    queryKey: ["grooming", "schedule", date, locationId],
    queryFn: () => get<GroomingSchedule>(`/api/grooming/schedule?date=${date}${locationId ? `&locationId=${locationId}` : ""}`),
    // Keep showing the previous day while the next one loads, so controls don't jump around.
    placeholderData: keepPreviousData,
  });
  const staff = useQuery({ queryKey: ["grooming", "staff"], queryFn: () => get<{ items: GroomingStaff[] }>("/api/grooming/staff"), enabled: canAssign });

  const s = schedule.data;
  const isColumn = s?.groomers.some((g) => g.membershipId === me.membershipId) ?? false;
  const appointments = s?.appointments ?? [];
  const unassigned = appointments.filter((a) => !a.groomerMembershipId);
  const columns = (s?.groomers ?? []).filter((g) => !mine || g.membershipId === me.membershipId);
  const active = appointments.filter((a) => a.status !== "no_show");

  return (
    <>
      <PageHeader title="Grooming" description={s
        ? <>{formatDate(date)} at {s.location.name} · {active.length} appointment{active.length === 1 ? "" : "s"}{unassigned.length > 0 && <> · <strong>{unassigned.length} without a groomer</strong></>}</>
        : "Appointments by groomer."}
        actions={canBook && <Link className="btn btn-primary" to="/reservations/new">New appointment</Link>} />
      <div className="filters">
        <div className="actions" role="group" aria-label="Day">
          <button className="btn" onClick={() => set({ date: shift(date, -1) })}>Previous day</button>
          <button className={`btn ${date === today() ? "btn-primary" : ""}`} aria-pressed={date === today()} onClick={() => set({ date: today() })}>Today</button>
          <button className="btn" onClick={() => set({ date: shift(date, 1) })}>Next day</button>
        </div>
        <TextField label="Date" type="date" value={date} onChange={(e) => e.target.value && set({ date: e.target.value })} />
        {(locations.data?.items.length ?? 0) > 1 && (
          <SelectField label="Location" value={locationId || s?.location.id || ""} onChange={(e) => set({ location: e.target.value })}>
            {locations.data!.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </SelectField>
        )}
        {isColumn && <Checkbox label="Only my appointments" checked={mine} onChange={(e) => set({ mine: e.target.checked ? "1" : "" })} />}
      </div>
      <ErrorAlert error={schedule.error} />
      {schedule.isPending ? <Loading /> : s && (
        appointments.length === 0 && columns.length === 0
          ? <Panel><EmptyState title="No grooming appointments this day">Book grooming from a customer's page or with New appointment.</EmptyState></Panel>
          : (
            <div className="care-grid">
              {!mine && unassigned.length > 0 && (
                <Panel title={`Not assigned (${unassigned.length})`}>
                  <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                    {unassigned.map((a) => <AppointmentCard key={a.id} a={a} staff={staff.data?.items ?? []} canAssign={canAssign} />)}
                  </ul>
                </Panel>
              )}
              {columns.map((g) => {
                const list = appointments.filter((a) => a.groomerMembershipId === g.membershipId);
                const busy = list.filter((a) => a.status !== "no_show")
                  .reduce((n, a) => n + (new Date(a.endsAt).getTime() - new Date(a.startsAt).getTime()) / 60_000, 0);
                return (
                  <Panel key={g.membershipId} title={<>{g.name}{g.membershipId === me.membershipId && " (you)"}</>}
                    actions={<span className="muted" style={{ fontSize: "0.875rem" }}>{list.length} · {Math.floor(busy / 60)}h{busy % 60 ? ` ${Math.round(busy % 60)}m` : ""} booked</span>}>
                    <p className="muted" style={{ margin: "0 0 8px" }}>
                      {g.shifts.length ? `On shift ${g.shifts.map((sh) => `${formatTime(sh.startsAt)}–${formatTime(sh.endsAt)}`).join(", ")}` : "No shift scheduled"}
                    </p>
                    {list.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing booked.</p> : (
                      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
                        {list.map((a) => <AppointmentCard key={a.id} a={a} staff={staff.data?.items ?? []} canAssign={canAssign}
                          outsideShift={g.shifts.length > 0 && a.status !== "no_show" && !g.shifts.some((sh) => sh.startsAt <= a.startsAt && sh.endsAt >= a.endsAt)
                            ? `Outside ${g.name}'s shift` : undefined} />)}
                      </ul>
                    )}
                  </Panel>
                );
              })}
            </div>
          )
      )}
    </>
  );
}
