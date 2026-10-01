import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeHoursProblem, estimateReservation, formatMoney, hoursProblem, PRICE_UNIT_LABELS, summarizeHours, WEEKDAY_LABELS, type PriceUnit } from "@pawguild/shared";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ApiError, get, patch, post, type Customer, type GroomingStaff, type CustomerListItem, type Location, type Reservation, type Service,
} from "../api";
import { useCan, useMe } from "../auth";
import { Checkbox, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextArea, TextField } from "../components/ui";
import { formatDate, formatTime, fromLocalInput, toLocalInput } from "../units";

interface SeriesResult {
  occurrences: { date: string; startsAt: string; endsAt: string; ok: boolean; reason?: string; reservationId?: string }[];
  bookable: number;
}

/** Sensible default times for a new booking, by service category. */
function defaultTimes(service: Service | undefined, day: Date): { start: string; end: string } {
  const at = (d: Date, h: number, m = 0) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const next = new Date(day); next.setDate(next.getDate() + 1);
  if (service?.category === "boarding") return { start: toLocalInput(at(day, 14)), end: toLocalInput(at(next, 11)) };
  if (service?.durationMinutes) {
    const s = at(day, 10);
    return { start: toLocalInput(s), end: toLocalInput(new Date(s.getTime() + service.durationMinutes * 60_000)) };
  }
  return { start: toLocalInput(at(day, 7, 30)), end: toLocalInput(at(day, 18)) };
}

function CustomerPicker({ onPick }: { onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: ["customers", "picker", q],
    queryFn: () => get<{ items: CustomerListItem[] }>(`/api/customers?${new URLSearchParams({ q, limit: "10" })}`),
    enabled: q.trim().length >= 2,
  });
  return (
    <Panel title="Choose a customer">
      <div className="field search">
        <label htmlFor="pick-customer">Search by name, phone, email or pet</label>
        <input id="pick-customer" type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {results.data && (
        results.data.items.length === 0 ? <p className="muted">No customers match. <Link to="/customers/new">Create a customer</Link> first.</p> : (
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "12px 0 0", gap: 6 }}>
            {results.data.items.map((c) => (
              <li key={c.id}>
                <button type="button" className="btn" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => onPick(c.id)}>
                  {c.lastName}, {c.firstName}{c.petNames.length > 0 && <span className="muted"> · {c.petNames.join(", ")}</span>}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </Panel>
  );
}

export function ReservationFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const existing = useQuery({ queryKey: ["reservation", id], queryFn: () => get<Reservation>(`/api/reservations/${id}`), enabled: editing });
  const customerId = editing ? existing.data?.customer.id : params.get("customerId") ?? undefined;
  const customer = useQuery({ queryKey: ["customer", customerId], queryFn: () => get<Customer>(`/api/customers/${customerId}`), enabled: Boolean(customerId) });
  const services = useQuery({ queryKey: ["services"], queryFn: () => get<{ items: Service[] }>("/api/services") });
  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations") });

  const [serviceId, setServiceId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [petIds, setPetIds] = useState<string[]>([]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [confirmNow, setConfirmNow] = useState(true);
  const [overrideCapacity, setOverrideCapacity] = useState(false);
  const canOverride = useCan("reservations:override_capacity");
  const [overrideHours, setOverrideHours] = useState(false);
  const [groomerId, setGroomerId] = useState("");
  const canOverrideHours = useCan("reservations:override_hours");

  const service = services.data?.items.find((s) => s.id === (editing ? existing.data?.service.id : serviceId));
  const isGrooming = service?.category === "grooming";
  const staff = useQuery({ queryKey: ["grooming", "staff"], queryFn: () => get<{ items: GroomingStaff[] }>("/api/grooming/staff"), enabled: isGrooming });
  const activePets = useMemo(() => (customer.data?.pets ?? []).filter((p) => !p.archivedAt && p.status === "active"), [customer.data]);

  useEffect(() => {
    if (existing.data) {
      setPetIds(existing.data.pets.map((p) => p.id));
      setStart(toLocalInput(existing.data.startsAt));
      setEnd(toLocalInput(existing.data.endsAt));
      setNotes(existing.data.notes ?? "");
      setGroomerId(existing.data.groomer?.membershipId ?? "");
    }
  }, [existing.data]);
  useEffect(() => { if (!editing && activePets.length === 1) setPetIds([activePets[0]!.id]); }, [editing, activePets]);
  useEffect(() => { if (!locationId && locations.data?.items.length === 1) setLocationId(locations.data.items[0]!.id); }, [locations.data, locationId]);

  const estimate = useMemo(() => {
    const s = fromLocalInput(start); const e = fromLocalInput(end);
    const unit = (editing ? existing.data?.priceUnit : service?.priceUnit) as PriceUnit | undefined;
    const price = editing ? existing.data?.unitPriceCents : service?.priceCents;
    if (!s || !e || !unit || price == null || petIds.length === 0 || new Date(e) <= new Date(s)) return null;
    return { unit, ...estimateReservation({ unit, unitPriceCents: price, startsAt: new Date(s), endsAt: new Date(e), petCount: petIds.length, timeZone: me.organization.timezone }) };
  }, [start, end, service, petIds, existing.data, editing, me.organization.timezone]);

  const save = useMutation({
    mutationFn: () => {
      const startsAt = fromLocalInput(start);
      const endsAt = fromLocalInput(end);
      if (!startsAt || !endsAt) {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [
          ...(!startsAt ? [{ path: "startsAt", message: "Choose a start date and time" }] : []),
          ...(!endsAt ? [{ path: "endsAt", message: "Choose an end date and time" }] : []),
        ]);
      }
      return editing
        ? patch<Reservation>(`/api/reservations/${id}`, { petIds, startsAt, endsAt, notes, overrideCapacity, overrideHours, ...(isGrooming && { groomerMembershipId: groomerId || null }) })
        : post<Reservation>("/api/reservations", {
            customerId, locationId, serviceId, petIds, startsAt, endsAt, notes, overrideCapacity, overrideHours,
            ...(isGrooming && groomerId && { groomerMembershipId: groomerId }),
            status: confirmNow ? "confirmed" : "pending",
          });
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["reservations"] });
      qc.invalidateQueries({ queryKey: ["reservation", r.id] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      navigate(`/reservations/${r.id}`);
    },
  });
  // Repeating bookings (same-day services only).
  const canRepeat = !editing && Boolean(service) && service?.priceUnit !== "per_night";
  const [repeat, setRepeat] = useState(false);
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [rFrom, setRFrom] = useState(() => toLocalInput(new Date()).slice(0, 10));
  const [rUntil, setRUntil] = useState(() => toLocalInput(new Date(Date.now() + 27 * 86_400_000)).slice(0, 10));
  const repeating = canRepeat && repeat;
  const seriesBody = () => ({
    customerId, locationId, serviceId, petIds, weekdays, notes, status: confirmNow ? "confirmed" : "pending",
    startTime: start.slice(11, 16), endTime: end.slice(11, 16), firstDate: rFrom, lastDate: rUntil,
    ...(isGrooming && groomerId && { groomerMembershipId: groomerId }),
  });
  const bodyKey = JSON.stringify(seriesBody());
  const preview = useMutation({
    mutationFn: () => post<SeriesResult>("/api/reservation-series/preview", seriesBody()).then((r) => ({ ...r, key: bodyKey })),
  });
  const bookSeries = useMutation({
    mutationFn: () => post<SeriesResult & { seriesId: string }>("/api/reservation-series", seriesBody()),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["reservations"] }); qc.invalidateQueries({ queryKey: ["dashboard"] });
      const first = r.occurrences.find((o) => o.reservationId);
      navigate(first ? `/reservations/${first.reservationId}` : `/customers/${customerId}`);
    },
  });
  const previewFresh = preview.data && preview.data.key === bodyKey;
  const err = fieldErrors(repeating ? (bookSeries.error ?? preview.error) : save.error);
  const capacityFull = save.error instanceof ApiError && save.error.code === "capacity_full";
  const outsideHours = save.error instanceof ApiError && save.error.code === "outside_hours";
  const location = locations.data?.items.find((l) => l.id === (editing ? existing.data?.location.id : locationId));
  const hoursWarnings = useMemo(() => {
    if (!location) return [];
    return ([["Drop-off", start, editing ? existing.data?.startsAt : undefined], ["Pick-up", end, editing ? existing.data?.endsAt : undefined]] as const)
      .flatMap(([what, value, original]) => {
        const iso = fromLocalInput(value);
        // When editing, only a moved time is checked (same as the server).
        if (!iso || (original && new Date(original).getTime() === new Date(iso).getTime())) return [];
        const p = hoursProblem(new Date(iso), location.effectiveTimezone, location.hours, location.closures);
        return p ? [describeHoursProblem(what, p)] : [];
      });
  }, [location, start, end, editing, existing.data]);

  if (!editing && !customerId) {
    return (
      <>
        <PageHeader breadcrumb={<Link to="/reservations">Reservations</Link>} title="New reservation" />
        <CustomerPicker onPick={(cid) => setParams({ customerId: cid })} />
      </>
    );
  }
  if (existing.isPending && editing) return <Loading />;
  if (customer.isPending || services.isPending || locations.isPending) return <Loading />;
  const loadError = existing.error ?? customer.error ?? services.error ?? locations.error;
  if (loadError) return <ErrorAlert error={loadError} />;
  const c = customer.data!;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!repeating) save.mutate();
    else if (previewFresh) bookSeries.mutate();
    else preview.mutate();
  }
  function chooseService(sid: string) {
    setServiceId(sid);
    const s = services.data?.items.find((x) => x.id === sid);
    const day = start ? new Date(start) : new Date();
    const t = defaultTimes(s, day);
    setStart(t.start); setEnd(t.end);
  }

  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/reservations">Reservations</Link>{editing && <> / <Link to={`/reservations/${id}`}>Reservation</Link></>}</>}
        title={editing ? "Edit reservation" : "New reservation"}
        description={<>For <Link to={`/customers/${c.id}`}>{c.firstName} {c.lastName}</Link>{editing && ` · ${existing.data!.service.name} at ${existing.data!.location.name}`}</>}
      />
      <ErrorAlert error={repeating ? (bookSeries.error ?? preview.error) : save.error} />
      {activePets.length === 0 && <div className="alert alert-warning">This customer has no active pets. <Link to={`/customers/${c.id}/pets/new`}>Add a pet</Link> first.</div>}
      <form className="stack" onSubmit={onSubmit} noValidate>
        {!editing && (
          <fieldset>
            <legend>Service</legend>
            <div className="form-grid">
              <SelectField label="Service" required value={serviceId} onChange={(e) => chooseService(e.target.value)} error={err("serviceId")}>
                <option value="">Choose a service…</option>
                {services.data!.items.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} — {formatMoney(s.priceCents)} {PRICE_UNIT_LABELS[s.priceUnit as PriceUnit]}</option>
                ))}
              </SelectField>
              {locations.data!.items.length > 1 && (
                <SelectField label="Location" required value={locationId} onChange={(e) => setLocationId(e.target.value)} error={err("locationId")}>
                  <option value="">Choose a location…</option>
                  {locations.data!.items.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </SelectField>
              )}
            </div>
          </fieldset>
        )}
        <fieldset>
          <legend>Pets</legend>
          <div className="pet-picker" role="group" aria-describedby={err("petIds") ? "pets-error" : undefined}>
            {activePets.map((p) => (
              <Checkbox key={p.id} label={`${p.name}${p.breed ? ` (${p.breed})` : ""}`} checked={petIds.includes(p.id)}
                onChange={(e) => setPetIds((ids) => e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))} />
            ))}
          </div>
          {err("petIds") && <p id="pets-error" className="field error" style={{ color: "var(--danger)", margin: "8px 0 0" }}>{err("petIds")}</p>}
        </fieldset>
        <fieldset>
          <legend>When</legend>
          {canRepeat && <Checkbox label="Repeat on a schedule (e.g. every Mon, Wed and Fri)" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />}
          {repeating ? (
            <div className="stack" style={{ gap: 12, marginTop: 8 }}>
              <div role="group" aria-label="Repeat on" className="pet-picker">
                {[1, 2, 3, 4, 5, 6, 0].map((w) => (
                  <Checkbox key={w} label={WEEKDAY_LABELS[w]!} checked={weekdays.includes(w)}
                    onChange={(e) => setWeekdays((d) => e.target.checked ? [...d, w] : d.filter((x) => x !== w))} />
                ))}
              </div>
              {err("weekdays") && <p className="field error" style={{ color: "var(--danger)", margin: 0 }}>{err("weekdays")}</p>}
              <div className="form-grid">
                <TextField label="Drop-off time" type="time" value={start.slice(11, 16)} onChange={(e) => setStart(`${(start || rFrom + "T").slice(0, 11)}${e.target.value}`)} />
                <TextField label="Pick-up time" type="time" value={end.slice(11, 16)} onChange={(e) => setEnd(`${(end || rFrom + "T").slice(0, 11)}${e.target.value}`)} error={err("endTime")} />
                <TextField label="From" type="date" value={rFrom} onChange={(e) => setRFrom(e.target.value)} error={err("firstDate")} />
                <TextField label="Until" type="date" value={rUntil} min={rFrom} onChange={(e) => setRUntil(e.target.value)} error={err("lastDate")} />
              </div>
            </div>
          ) : (
          <div className="form-grid">
            <TextField label="Drop-off" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} error={err("startsAt")} />
            <TextField label="Pick-up" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} error={err("endsAt")} />
          </div>
          )}
          {location && (location.hours.length > 0 || location.closures.length > 0) && (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {location.name}: {summarizeHours(location.hours)}
              {location.closures.length > 0 && <> · Closed {location.closures.slice(0, 3).map((c) => formatDate(c.closedOn)).join(", ")}{location.closures.length > 3 && ", …"}</>}
            </p>
          )}
          {!repeating && hoursWarnings.length > 0 && !outsideHours && (
            <div className="alert alert-warning" role="status" style={{ margin: "8px 0 0" }}>{hoursWarnings.join(". ")}.</div>
          )}
        </fieldset>
        {isGrooming && (
          <SelectField label="Groomer" value={groomerId} onChange={(e) => setGroomerId(e.target.value)} error={err("groomerMembershipId")}
            hint="Optional. You can also assign from the grooming schedule.">
            <option value="">Not assigned yet</option>
            {(() => {
              const items = staff.data?.items ?? [];
              // Keep a current groomer who has since been deactivated visible.
              const current = existing.data?.groomer;
              const groomers = items.filter((s) => s.role === "groomer");
              const others = items.filter((s) => s.role !== "groomer");
              return <>
                {current && !items.some((s) => s.membershipId === current.membershipId) && <option value={current.membershipId}>{current.name}</option>}
                {groomers.length > 0 && <optgroup label="Groomers">{groomers.map((s) => <option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}</optgroup>}
                {others.length > 0 && <optgroup label="Other staff">{others.map((s) => <option key={s.membershipId} value={s.membershipId}>{s.name}</option>)}</optgroup>}
              </>;
            })()}
          </SelectField>
        )}
        <TextArea label="Reservation notes" hint="Visible to staff." value={notes} onChange={(e) => setNotes(e.target.value)} error={err("notes")} />
        {repeating && previewFresh && preview.data && (
          <section className="panel" aria-labelledby="series-preview-title">
            <div className="panel-header"><h2 id="series-preview-title">{preview.data.bookable} of {preview.data.occurrences.length} dates can be booked</h2></div>
            <ul style={{ listStyle: "none", margin: 0, padding: "4px 16px", maxHeight: 320, overflowY: "auto" }} aria-label="Dates">
              {preview.data.occurrences.map((o) => (
                <li key={o.date} className="dose">
                  <span>{o.ok ? "✓" : "✗"} <strong>{formatDate(o.date)}</strong> {formatTime(o.startsAt)}–{formatTime(o.endsAt)}</span>
                  {o.ok ? <span className="badge badge-success">Will be booked</span> : <span className="muted" style={{ flexBasis: "100%" }}>Skipped: {o.reason}</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {!repeating && estimate && (
          <div className="estimate" aria-live="polite">
            <span>{estimate.quantity} {PRICE_UNIT_LABELS[estimate.unit].replace("per ", "")}{estimate.quantity === 1 ? "" : "s"} × {estimate.petCount} pet{estimate.petCount === 1 ? "" : "s"} × {formatMoney(estimate.unitPriceCents)}</span>
            <span>Estimated <strong>{formatMoney(estimate.totalCents)}</strong></span>
          </div>
        )}
        {(capacityFull || overrideCapacity) && canOverride && (
          <div className="alert alert-warning">
            <Checkbox label="Book over capacity (manager override — recorded in history)" checked={overrideCapacity} onChange={(e) => setOverrideCapacity(e.target.checked)} />
          </div>
        )}
        {(outsideHours || overrideHours) && canOverrideHours && (
          <div className="alert alert-warning">
            <Checkbox label="Book outside business hours (manager override — recorded in history)" checked={overrideHours} onChange={(e) => setOverrideHours(e.target.checked)} />
          </div>
        )}
        {!editing && <Checkbox label="Mark as confirmed" checked={confirmNow} onChange={(e) => setConfirmNow(e.target.checked)} />}
        <div className="actions">
          {repeating ? (
            <button className="btn btn-primary" type="submit" disabled={preview.isPending || bookSeries.isPending || activePets.length === 0 || (previewFresh && preview.data!.bookable === 0)}>
              {preview.isPending ? "Checking…" : bookSeries.isPending ? "Booking…" : previewFresh ? `Book ${preview.data!.bookable} date${preview.data!.bookable === 1 ? "" : "s"}` : "Check dates"}
            </button>
          ) : (
          <button className="btn btn-primary" type="submit" disabled={save.isPending || activePets.length === 0}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create reservation"}
          </button>
          )}
          <Link className="btn" to={editing ? `/reservations/${id}` : `/customers/${c.id}`}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
