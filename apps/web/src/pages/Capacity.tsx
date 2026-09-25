import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatBps, parsePercentToBps, RESOURCE_KIND_LABELS, RESOURCE_KINDS, type ResourceKind } from "@pawguild/shared";
import { useEffect, useState, type FormEvent } from "react";
import { ApiError, get, patch, post, put, type Location, type Resource } from "../api";
import { useCan } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextField } from "../components/ui";

function parseLimit(value: string, path: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path, message: "Enter a whole number, or leave blank for no limit" }]);
  return n;
}

function LimitsForm({ location }: { location: Location }) {
  const qc = useQueryClient();
  const canManage = useCan("locations:manage");
  const [daycare, setDaycare] = useState(location.capacity.daycare?.toString() ?? "");
  const [boarding, setBoarding] = useState(location.capacity.boarding?.toString() ?? "");
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => put(`/api/locations/${location.id}/capacity`, { daycare: parseLimit(daycare, "daycare"), boarding: parseLimit(boarding, "boarding") }),
    onSuccess: () => { setSaved(true); qc.invalidateQueries({ queryKey: ["locations"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); setSaved(false); save.mutate(); }
  if (!canManage) {
    return (
      <dl className="details">
        <dt>Daycare</dt><dd>{location.capacity.daycare ?? "No limit"}{location.capacity.daycare != null && " pets per day"}</dd>
        <dt>Boarding</dt><dd>{location.capacity.boarding ?? "No limit"}{location.capacity.boarding != null && " pets per night"}</dd>
      </dl>
    );
  }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={`Capacity limits for ${location.name}`}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Daycare (pets per day)" inputMode="numeric" hint="Leave blank for no limit" value={daycare} onChange={(e) => setDaycare(e.target.value)} error={err("daycare")} />
        <TextField label="Boarding (pets per night)" inputMode="numeric" hint="Leave blank for no limit" value={boarding} onChange={(e) => setBoarding(e.target.value)} error={err("boarding")} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>Save limits</button>
        {saved && <span role="status" className="muted" style={{ alignSelf: "center" }}>Saved.</span>}
      </div>
    </form>
  );
}

function TaxRateForm({ location }: { location: Location }) {
  const qc = useQueryClient();
  const canManage = useCan("locations:manage");
  const [rate, setRate] = useState(formatBps(location.taxRateBps).replace("%", ""));
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => {
      let taxRateBps: number;
      try { taxRateBps = parsePercentToBps(rate); } catch (e) {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "taxRateBps", message: (e as Error).message }]);
      }
      return put(`/api/locations/${location.id}/tax-rate`, { taxRateBps });
    },
    onSuccess: () => { setSaved(true); qc.invalidateQueries({ queryKey: ["locations"] }); },
  });
  if (!canManage) return <p style={{ margin: 0 }}>Sales tax: {formatBps(location.taxRateBps)} on taxable services.</p>;
  function onSubmit(e: FormEvent) { e.preventDefault(); setSaved(false); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={`Sales tax for ${location.name}`}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Sales tax rate (%)" inputMode="decimal" hint="Applied to services marked taxable. Use 0 for no tax."
          value={rate} onChange={(e) => setRate(e.target.value)} error={fieldErrors(save.error)("taxRateBps")} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>Save tax rate</button>
        {saved && <span role="status" className="muted" style={{ alignSelf: "center" }}>Saved. Applies to new and draft invoices.</span>}
      </div>
    </form>
  );
}

const emptyResource = { name: "", kind: "kennel", capacity: "1", notes: "", isActive: true };

function ResourceForm({ locationId, resource, onDone }: { locationId: string; resource?: Resource; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(resource
    ? { name: resource.name, kind: resource.kind, capacity: String(resource.capacity), notes: resource.notes ?? "", isActive: resource.isActive }
    : emptyResource);
  useEffect(() => { if (!resource) setForm(emptyResource); }, [resource]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name, kind: form.kind, capacity: Number(form.capacity), notes: form.notes, isActive: form.isActive };
      return resource ? patch(`/api/resources/${resource.id}`, body) : post("/api/resources", { ...body, locationId });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["resources"] }); onDone(); },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={resource ? `Edit ${resource.name}` : "Add kennel or room"}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={err("name")} />
        <SelectField label="Type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} error={err("kind")}>
          {RESOURCE_KINDS.map((k) => <option key={k} value={k}>{RESOURCE_KIND_LABELS[k]}</option>)}
        </SelectField>
        <TextField label="Holds (pets)" inputMode="numeric" value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} error={err("capacity")} />
        <TextField label="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} error={err("notes")} />
        {resource && <Checkbox label="In use" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{resource ? "Save" : "Add"}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function Resources({ location }: { location: Location }) {
  const canManage = useCan("resources:manage");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = useQuery({
    queryKey: ["resources", location.id, "all"],
    queryFn: () => get<{ items: Resource[] }>(`/api/resources?locationId=${location.id}&includeInactive=true`),
  });
  return (
    <Panel title={`Kennels and rooms — ${location.name}`} bodyless
      actions={canManage && editing !== "new" && <button className="btn btn-small btn-primary" onClick={() => setEditing("new")}>Add kennel or room</button>}>
      {editing === "new" && <div className="panel-body"><ResourceForm locationId={location.id} onDone={() => setEditing(null)} /></div>}
      {list.isPending ? <div className="panel-body"><Loading /></div> : list.error ? <div className="panel-body"><ErrorAlert error={list.error} /></div> :
        list.data.items.length === 0 ? <EmptyState title="No kennels or rooms yet">Add them to assign pets to specific spaces.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Holds</th><th scope="col">Status</th>{canManage && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
              <tbody>
                {list.data.items.map((r) => editing === r.id ? (
                  <tr key={r.id}><td colSpan={5}><ResourceForm locationId={location.id} resource={r} onDone={() => setEditing(null)} /></td></tr>
                ) : (
                  <tr key={r.id}>
                    <td>{r.name}{r.notes && <div className="muted">{r.notes}</div>}</td>
                    <td>{RESOURCE_KIND_LABELS[r.kind as ResourceKind] ?? r.kind}</td>
                    <td>{r.capacity} pet{r.capacity === 1 ? "" : "s"}</td>
                    <td>{r.isActive ? <span className="badge badge-success">In use</span> : <span className="badge">Not in use</span>}</td>
                    {canManage && <td className="row-actions"><button className="btn btn-small" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r.id)}>Edit</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

export function CapacityPage() {
  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations") });
  return (
    <>
      <PageHeader title="Locations" description="Capacity, sales tax and the kennels and rooms at each location." />
      <ErrorAlert error={locations.error} />
      {locations.isPending ? <Loading /> : locations.data && (
        <div className="stack">
          {locations.data.items.map((l) => (
            <div key={l.id} className="stack">
              <Panel title={`Capacity limits — ${l.name}`}><LimitsForm location={l} /></Panel>
              <Panel title={`Sales tax — ${l.name}`}><TaxRateForm location={l} /></Panel>
              <Resources location={l} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
