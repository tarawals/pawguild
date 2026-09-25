import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { parseTimesOfDay } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { ApiError, get, post, type Medication } from "../api";
import { useCan } from "../auth";
import { ErrorAlert, fieldErrors, Panel, TextField } from "./ui";

const to12h = (t: string) => {
  const [h, m] = t.split(":").map(Number) as [number, number];
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};

/** Standing medication orders on a pet. Discontinued, never deleted. */
export function MedicationsPanel({ petId, archived }: { petId: string; archived: boolean }) {
  const qc = useQueryClient();
  const canWrite = useCan("pets:write");
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", dosage: "", times: "", instructions: "" });
  const meds = useQuery({ queryKey: ["medications", petId], queryFn: () => get<{ items: Medication[] }>(`/api/pets/${petId}/medications`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["medications", petId] }); qc.invalidateQueries({ queryKey: ["care"] }); qc.invalidateQueries({ queryKey: ["audit"] }); };
  const add = useMutation({
    mutationFn: () => {
      let times: string[];
      try { times = parseTimesOfDay(form.times); } catch (e) {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "times", message: (e as Error).message }]);
      }
      return post(`/api/pets/${petId}/medications`, { name: form.name, dosage: form.dosage, instructions: form.instructions, times });
    },
    onSuccess: () => { setForm({ name: "", dosage: "", times: "", instructions: "" }); setAdding(false); refresh(); },
  });
  const discontinue = useMutation({ mutationFn: (id: string) => post(`/api/pets/${petId}/medications/${id}/discontinue`), onSuccess: refresh });
  const err = fieldErrors(add.error);
  const active = meds.data?.items.filter((m) => !m.discontinuedAt) ?? [];
  const past = meds.data?.items.filter((m) => m.discontinuedAt) ?? [];
  function onSubmit(e: FormEvent) { e.preventDefault(); add.mutate(); }

  return (
    <Panel title="Medications" actions={canWrite && !archived && !adding && <button className="btn btn-small btn-primary" onClick={() => setAdding(true)}>Add medication</button>}>
      <ErrorAlert error={meds.error ?? discontinue.error} />
      {active.length === 0 && !adding && <p className="muted" style={{ margin: 0 }}>No current medications.</p>}
      {active.map((m) => (
        <div className="dose" key={m.id}>
          <span>
            <strong>{m.name}</strong> · {m.dosage} · {m.times.length ? m.times.map(to12h).join(", ") : "as needed"}
            {m.instructions && <div className="muted">{m.instructions}</div>}
          </span>
          {canWrite && <button className="btn btn-small" aria-label={`Discontinue ${m.name}`} onClick={() => {
            if (window.confirm(`Discontinue ${m.name}? It stops appearing in daily care. Past doses stay in the records.`)) discontinue.mutate(m.id);
          }}>Discontinue</button>}
        </div>
      ))}
      {past.length > 0 && <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.875rem" }}>Discontinued: {past.map((m) => m.name).join(", ")}</p>}
      {adding && (
        <form className="stack" onSubmit={onSubmit} noValidate style={{ marginTop: 12 }} aria-label="Add medication">
          <ErrorAlert error={add.error} />
          <div className="form-grid">
            <TextField label="Medication" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={err("name")} />
            <TextField label="Dose" required hint="e.g. 1 tablet (16 mg)" value={form.dosage} onChange={(e) => setForm({ ...form, dosage: e.target.value })} error={err("dosage")} />
            <TextField label="Times" hint="e.g. 8:00 am, 6:00 pm. Leave blank if as needed." value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} error={err("times")} />
            <TextField label="Instructions" hint="e.g. with food" value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} />
          </div>
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={add.isPending}>Save medication</button>
            <button className="btn" type="button" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
    </Panel>
  );
}
