import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WEEKDAY_LABELS, formatTimeOfDay } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { post, type Reservation } from "../api";
import { useCan } from "../auth";
import { ErrorAlert, fieldErrors, Panel, TextField } from "./ui";
import { formatDate, toLocalInput } from "../units";

/** Shows the repeating pattern a reservation belongs to, and cancels this and later occurrences. */
export function SeriesPanel({ reservation: r }: { reservation: Reservation }) {
  const canWrite = useCan("reservations:write");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const fromDate = toLocalInput(r.startsAt).slice(0, 10);
  const cancel = useMutation({
    mutationFn: () => post<{ cancelled: number }>(`/api/reservation-series/${r.series!.id}/cancel`, { fromDate, reason }),
    onSuccess: (res) => {
      setOpen(false); setReason("");
      setDone(`Cancelled ${res.cancelled} booking${res.cancelled === 1 ? "" : "s"} from ${formatDate(fromDate)} on.`);
      qc.invalidateQueries({ queryKey: ["reservation"] }); qc.invalidateQueries({ queryKey: ["reservations"] }); qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
  if (!r.series) return null;
  const s = r.series;
  const days = [1, 2, 3, 4, 5, 6, 0].filter((w) => s.weekdays.includes(w)).map((w) => WEEKDAY_LABELS[w]!.slice(0, 3)).join(", ");
  const err = fieldErrors(cancel.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); cancel.mutate(); }
  return (
    <Panel title="Repeating booking">
      <div className="stack" style={{ gap: 8 }}>
        <p style={{ margin: 0 }}>
          Every {days}, {formatTimeOfDay(s.startTime)}–{formatTimeOfDay(s.endTime)}, {formatDate(s.firstDate)} – {formatDate(s.lastDate)}.
          <span className="muted"> {s.upcoming} upcoming.</span>
        </p>
        {done && <div role="status" className="alert alert-warning" style={{ marginBottom: 0 }}>{done}</div>}
        {canWrite && s.upcoming > 0 && (r.status === "pending" || r.status === "confirmed") && !open && (
          <div><button className="btn btn-danger btn-small" onClick={() => setOpen(true)}>Cancel this and following</button></div>
        )}
        {open && (
          <form onSubmit={onSubmit} noValidate className="stack" aria-label="Cancel this and following">
            <ErrorAlert error={cancel.error} />
            <TextField label="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} error={err("reason")}
              hint={`Cancels every booking in this series from ${formatDate(fromDate)} on that hasn't started yet.`} />
            <div className="actions">
              <button className="btn btn-danger" type="submit" disabled={cancel.isPending}>Cancel bookings</button>
              <button className="btn" type="button" onClick={() => setOpen(false)}>Keep them</button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
