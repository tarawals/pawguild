import { useMutation, useQueryClient } from "@tanstack/react-query";
import { INCIDENT_CATEGORIES, INCIDENT_CATEGORY_LABELS, INCIDENT_SEVERITIES } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { post } from "../api";
import { Checkbox, ErrorAlert, fieldErrors, SelectField, TextArea } from "./ui";

export function IncidentForm({ petId, petName, reservationId, onDone }: { petId: string; petName: string; reservationId?: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ category: "injury", severity: "low", description: "", actionsTaken: "", ownerNotified: false, followUpRequired: false });
  const save = useMutation({
    mutationFn: () => post("/api/incidents", { ...form, petId, reservationId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["incidents"] });
      qc.invalidateQueries({ queryKey: ["care"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      onDone();
    },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form className="stack alert alert-warning" style={{ marginTop: 12 }} onSubmit={onSubmit} noValidate aria-label={`Report incident for ${petName}`}>
      <strong>Report an incident — {petName}</strong>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <SelectField label="What happened" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
          {INCIDENT_CATEGORIES.map((c) => <option key={c} value={c}>{INCIDENT_CATEGORY_LABELS[c]}</option>)}
        </SelectField>
        <SelectField label="Severity" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
          {INCIDENT_SEVERITIES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
        </SelectField>
      </div>
      <TextArea label="Description" hint="What happened, where, who was involved. This can't be edited later." value={form.description}
        onChange={(e) => setForm({ ...form, description: e.target.value })} error={err("description")} />
      <TextArea label="Actions taken" value={form.actionsTaken} onChange={(e) => setForm({ ...form, actionsTaken: e.target.value })} />
      <Checkbox label="Owner has been notified" checked={form.ownerNotified} onChange={(e) => setForm({ ...form, ownerNotified: e.target.checked })} />
      <Checkbox label="Needs follow-up" checked={form.followUpRequired} onChange={(e) => setForm({ ...form, followUpRequired: e.target.checked })} />
      <div className="actions">
        <button className="btn btn-danger" type="submit" disabled={save.isPending}>Submit incident report</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
