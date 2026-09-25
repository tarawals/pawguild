import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { INCIDENT_CATEGORY_LABELS } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { get, patch, type Incident } from "../api";
import { useCan } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, TextArea } from "../components/ui";
import { formatDateTime } from "../units";

function FollowUp({ incident, onDone }: { incident: Incident; onDone: () => void }) {
  const qc = useQueryClient();
  const canResolve = useCan("incidents:resolve");
  const [form, setForm] = useState({
    actionsTaken: incident.actionsTaken ?? "", followUpNotes: incident.followUpNotes ?? "",
    ownerNotified: incident.ownerNotified, followUpRequired: incident.followUpRequired, resolution: "",
  });
  const save = useMutation({
    mutationFn: () => {
      const { resolution, ...rest } = form;
      return patch(`/api/incidents/${incident.id}`, resolution.trim() ? { ...rest, resolution } : rest);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["incidents"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); qc.invalidateQueries({ queryKey: ["care"] }); onDone(); },
  });
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form className="stack" onSubmit={onSubmit} noValidate aria-label="Incident follow-up" style={{ marginTop: 12 }}>
      <ErrorAlert error={save.error} />
      <TextArea label="Actions taken" value={form.actionsTaken} onChange={(e) => setForm({ ...form, actionsTaken: e.target.value })} />
      <TextArea label="Follow-up notes" value={form.followUpNotes} onChange={(e) => setForm({ ...form, followUpNotes: e.target.value })} />
      <Checkbox label="Owner has been notified" checked={form.ownerNotified} onChange={(e) => setForm({ ...form, ownerNotified: e.target.checked })} />
      <Checkbox label="Needs follow-up" checked={form.followUpRequired} onChange={(e) => setForm({ ...form, followUpRequired: e.target.checked })} />
      {canResolve && <TextArea label="Resolution (resolves and locks the incident)" value={form.resolution}
        onChange={(e) => setForm({ ...form, resolution: e.target.value })} error={fieldErrors(save.error)("resolution")} />}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{form.resolution.trim() ? "Save and resolve" : "Save follow-up"}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function IncidentsPage() {
  const canRecord = useCan("incidents:record");
  const [params, setParams] = useSearchParams();
  const showAll = params.get("show") === "all";
  const [editing, setEditing] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["incidents", showAll],
    queryFn: () => get<{ items: Incident[] }>(`/api/incidents?${showAll ? "limit=100" : "open=true"}`),
  });
  return (
    <>
      <PageHeader title="Incidents" description="Injuries, illness, behavior and other events that need a record and follow-up."
        actions={<div className="actions">
          <button className={`btn btn-small ${!showAll ? "btn-primary" : ""}`} aria-pressed={!showAll} onClick={() => setParams({})}>Open</button>
          <button className={`btn btn-small ${showAll ? "btn-primary" : ""}`} aria-pressed={showAll} onClick={() => setParams({ show: "all" })}>All recent</button>
        </div>} />
      <ErrorAlert error={list.error} />
      {list.isPending ? <Loading /> : list.data && (list.data.items.length === 0
        ? <Panel><EmptyState title={showAll ? "No incidents recorded" : "No open incidents"}>Report incidents from Today's care.</EmptyState></Panel>
        : <div className="stack">{list.data.items.map((i) => (
          <Panel key={i.id} title={<><Link to={`/pets/${i.petId}`}>{i.petName}</Link> · {INCIDENT_CATEGORY_LABELS[i.category as keyof typeof INCIDENT_CATEGORY_LABELS] ?? i.category}{" "}
            <span className={`badge severity-${i.severity}`}>{i.severity[0]!.toUpperCase() + i.severity.slice(1)}</span>{" "}
            {i.resolvedAt ? <span className="badge badge-success">Resolved</span> : i.followUpRequired && <span className="badge badge-warning">Follow-up needed</span>}</>}
            actions={canRecord && !i.resolvedAt && editing !== i.id && <button className="btn btn-small" onClick={() => setEditing(i.id)}>Update</button>}>
            <dl className="details">
              <dt>When</dt><dd>{formatDateTime(i.occurredAt)}{i.reservationId && <> · <Link to={`/reservations/${i.reservationId}`}>View stay</Link></>}</dd>
              <dt>Reported by</dt><dd>{i.reportedBy}</dd>
              <dt>What happened</dt><dd>{i.description}</dd>
              <dt>Actions taken</dt><dd>{i.actionsTaken ?? "—"}</dd>
              <dt>Owner notified</dt><dd>{i.ownerNotified ? "Yes" : <span style={{ color: "var(--danger)" }}>Not yet</span>}</dd>
              {i.followUpNotes && <><dt>Follow-up</dt><dd>{i.followUpNotes}</dd></>}
              {i.resolvedAt && <><dt>Resolution</dt><dd>{i.resolution} — {i.resolvedBy}, {formatDateTime(i.resolvedAt)}</dd></>}
            </dl>
            {editing === i.id && <FollowUp incident={i} onDone={() => setEditing(null)} />}
          </Panel>
        ))}</div>)}
    </>
  );
}
