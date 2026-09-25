import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AMOUNT_EATEN_LABELS, CARE_KIND_LABELS, MEDICATION_STATUS_LABELS, type CareKind } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { get, post, type CareLogEntry, type Reservation } from "../api";
import { useCan } from "../auth";
import { formatDateTime, formatTime } from "../units";
import { EmptyState, ErrorAlert, fieldErrors, Loading, Panel, TextField } from "./ui";

function describe(e: CareLogEntry): string {
  if (e.kind === "feeding") return `Fed ${e.meal} — ${AMOUNT_EATEN_LABELS[e.amountEaten as keyof typeof AMOUNT_EATEN_LABELS]?.toLowerCase() ?? e.amountEaten}`;
  if (e.kind === "medication") {
    const status = MEDICATION_STATUS_LABELS[e.medicationStatus as keyof typeof MEDICATION_STATUS_LABELS] ?? e.medicationStatus;
    return `${e.medicationName} ${e.dose} — ${status}${e.scheduledFor ? ` (${formatTime(e.scheduledFor)} dose)` : " (as needed)"}`;
  }
  return CARE_KIND_LABELS[e.kind as CareKind] ?? e.kind;
}

function VoidForm({ entry, onDone }: { entry: CareLogEntry; onDone: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const voidIt = useMutation({
    mutationFn: () => post(`/api/care-logs/${entry.id}/void`, { reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["care-log"] }); qc.invalidateQueries({ queryKey: ["care"] }); qc.invalidateQueries({ queryKey: ["dashboard"] }); onDone(); },
  });
  function onSubmit(e: FormEvent) { e.preventDefault(); voidIt.mutate(); }
  return (
    <form className="inline-form" onSubmit={onSubmit} noValidate aria-label="Void entry">
      <TextField label="Why is this entry wrong?" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} error={fieldErrors(voidIt.error)("reason")} />
      <button className="btn btn-danger btn-small" type="submit" disabled={voidIt.isPending}>Void entry</button>
      <button className="btn btn-small" type="button" onClick={onDone}>Keep</button>
    </form>
  );
}

/** The stay's care history. Entries are never edited; mistakes are voided with a reason. */
export function CareLogPanel({ reservation }: { reservation: Reservation }) {
  const canCare = useCan("care:record");
  const [voiding, setVoiding] = useState<string | null>(null);
  const shown = reservation.status === "checked_in" || reservation.status === "completed";
  const log = useQuery({
    queryKey: ["care-log", reservation.id],
    queryFn: () => get<{ items: CareLogEntry[] }>(`/api/reservations/${reservation.id}/care-logs`),
    enabled: shown,
  });
  if (!shown) return null;
  return (
    <Panel title="Care log" bodyless actions={reservation.status === "checked_in" && canCare && <Link className="btn btn-small btn-primary" to="/care">Log care</Link>}>
      {log.isPending ? <div className="panel-body"><Loading /></div> : log.error ? <div className="panel-body"><ErrorAlert error={log.error} /></div> :
        log.data.items.length === 0 ? <EmptyState title="Nothing logged yet" /> : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {log.data.items.map((e) => (
              <li key={e.id} className={`log-entry ${e.voidedAt ? "voided" : ""}`}>
                <time dateTime={e.occurredAt} title={formatDateTime(e.occurredAt)}>{formatDateTime(e.occurredAt).replace(/^.*?, \d{4}, /, "")}</time>
                <div style={{ flex: 1 }}>
                  <div className="what"><strong>{e.petName}:</strong> {describe(e)}</div>
                  {e.notes && <div>{e.notes}</div>}
                  <div className="muted" style={{ fontSize: "0.85rem" }}>
                    {e.recordedBy}
                    {e.voidedAt && <> · <span style={{ color: "var(--danger)" }}>Voided by {e.voidedBy}: {e.voidReason}</span></>}
                  </div>
                  {voiding === e.id && <VoidForm entry={e} onDone={() => setVoiding(null)} />}
                </div>
                {canCare && !e.voidedAt && voiding !== e.id && (
                  <button className="btn btn-small" onClick={() => setVoiding(e.id)} aria-label={`Void: ${e.petName} ${describe(e)}`}>Void</button>
                )}
              </li>
            ))}
          </ol>
        )}
    </Panel>
  );
}
