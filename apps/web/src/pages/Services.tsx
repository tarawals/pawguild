import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatMoney, parseMoney, PRICE_UNIT_LABELS, PRICE_UNITS, SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS,
  type PriceUnit, type ServiceCategory,
} from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { ApiError, get, patch, post, type Service } from "../api";
import { useCan } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextArea, TextField } from "../components/ui";

const DEFAULT_UNIT: Record<ServiceCategory, PriceUnit> = {
  daycare: "per_day", boarding: "per_night", grooming: "per_visit", training: "per_visit", add_on: "per_visit", other: "per_visit",
};

const emptyForm = { name: "", category: "daycare", price: "", priceUnit: "per_day", durationMinutes: "", description: "", isActive: true };
type FormState = typeof emptyForm;

function toForm(s: Service): FormState {
  return {
    name: s.name, category: s.category, price: (s.priceCents / 100).toFixed(2), priceUnit: s.priceUnit,
    durationMinutes: s.durationMinutes ? String(s.durationMinutes) : "", description: s.description ?? "", isActive: s.isActive,
  };
}

function ServiceForm({ service, onDone }: { service?: Service; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(service ? toForm(service) : emptyForm);
  const save = useMutation({
    mutationFn: () => {
      let priceCents: number;
      try { priceCents = parseMoney(form.price); } catch {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "priceCents", message: "Enter a price like 38 or 38.50" }]);
      }
      const body = {
        name: form.name, category: form.category, priceCents, priceUnit: form.priceUnit, description: form.description,
        durationMinutes: form.durationMinutes ? Number(form.durationMinutes) : null, isActive: form.isActive,
      };
      return service ? patch(`/api/services/${service.id}`, body) : post("/api/services", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["services"] }); onDone(); },
  });
  const err = fieldErrors(save.error);
  const bind = (key: keyof FormState) => ({
    value: form[key] as string, onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={service ? `Edit ${service.name}` : "New service"}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Name" required {...bind("name")} error={err("name")} />
        <SelectField label="Category" value={form.category} error={err("category")} onChange={(e) => {
          const category = e.target.value as ServiceCategory;
          setForm((f) => ({ ...f, category, priceUnit: service ? f.priceUnit : DEFAULT_UNIT[category] }));
        }}>
          {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{SERVICE_CATEGORY_LABELS[c]}</option>)}
        </SelectField>
        <TextField label="Price ($)" inputMode="decimal" required {...bind("price")} error={err("priceCents")} />
        <SelectField label="Charged" {...bind("priceUnit")} error={err("priceUnit")}>
          {PRICE_UNITS.map((u) => <option key={u} value={u}>{PRICE_UNIT_LABELS[u]}</option>)}
        </SelectField>
        <TextField label="Duration (minutes)" inputMode="numeric" hint="For timed appointments such as grooming" {...bind("durationMinutes")} error={err("durationMinutes")} />
        <TextArea label="Description" className="span-all" {...bind("description")} error={err("description")} />
        {service && <Checkbox label="Offered (uncheck to stop new bookings)" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />}
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{service ? "Save service" : "Add service"}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function ServicesPage() {
  const canManage = useCan("services:manage");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const services = useQuery({ queryKey: ["services", "all"], queryFn: () => get<{ items: Service[] }>("/api/services?includeInactive=true") });

  return (
    <>
      <PageHeader
        title="Services"
        description="What you offer and what it costs. Price changes apply to new bookings only."
        actions={canManage && editing !== "new" && <button className="btn btn-primary" onClick={() => setEditing("new")}>New service</button>}
      />
      {editing === "new" && <Panel title="New service"><ServiceForm onDone={() => setEditing(null)} /></Panel>}
      <ErrorAlert error={services.error} />
      <div style={{ marginTop: 16 }}>
        <Panel bodyless>
          {services.isPending ? <div className="panel-body"><Loading /></div> : services.data && services.data.items.length === 0 ? (
            <EmptyState title="No services yet">Add daycare, boarding and grooming services to start taking reservations.</EmptyState>
          ) : services.data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Service</th><th scope="col">Category</th><th scope="col">Price</th><th scope="col">Status</th>{canManage && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
                <tbody>
                  {services.data.items.map((s) => editing === s.id ? (
                    <tr key={s.id}><td colSpan={5}><ServiceForm service={s} onDone={() => setEditing(null)} /></td></tr>
                  ) : (
                    <tr key={s.id}>
                      <td>{s.name}{s.durationMinutes && <div className="muted">{s.durationMinutes} min</div>}</td>
                      <td>{SERVICE_CATEGORY_LABELS[s.category as ServiceCategory] ?? s.category}</td>
                      <td>{formatMoney(s.priceCents)} <span className="muted">{PRICE_UNIT_LABELS[s.priceUnit as PriceUnit]}</span></td>
                      <td>{s.isActive ? <span className="badge badge-success">Offered</span> : <span className="badge">Not offered</span>}</td>
                      {canManage && <td className="row-actions"><button className="btn btn-small" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`}>Edit</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
