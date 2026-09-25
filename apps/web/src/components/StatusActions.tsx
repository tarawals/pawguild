import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { post, type Reservation } from "../api";
import { useCan } from "../auth";
import { ErrorAlert, fieldErrors, TextField } from "./ui";

const ACTION_LABELS: Record<string, string> = {
  confirmed: "Confirm", checked_in: "Check in", completed: "Check out", cancelled: "Cancel reservation", no_show: "Mark no-show",
};
const PRIMARY = new Set(["confirmed", "checked_in", "completed"]);

export function useStatusChange(reservationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { status: string; reason?: string }) => post<Reservation>(`/api/reservations/${reservationId}/status`, body),
    onSuccess: (r) => {
      qc.setQueryData(["reservation", reservationId], r);
      qc.invalidateQueries({ queryKey: ["reservations"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

/** Buttons for every status change the reservation allows and the user may perform. */
export function StatusActions({ reservation }: { reservation: Reservation }) {
  const canWrite = useCan("reservations:write");
  const canStay = useCan("stays:check_in_out");
  const change = useStatusChange(reservation.id);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const permitted = reservation.allowedTransitions.filter((t) =>
    t === "checked_in" || t === "completed" ? canStay : canWrite);
  if (permitted.length === 0) return null;

  function submitCancel(e: FormEvent) {
    e.preventDefault();
    change.mutate({ status: "cancelled", reason }, { onSuccess: () => setCancelling(false) });
  }

  return (
    <div>
      <div className="actions">
        {permitted.map((to) => (
          <button key={to} type="button" className={`btn ${PRIMARY.has(to) ? "btn-primary" : to === "cancelled" ? "btn-danger" : ""}`}
            disabled={change.isPending}
            onClick={() => {
              if (to === "cancelled") return setCancelling(true);
              if (to === "no_show" && !window.confirm("Mark this reservation as a no-show? This can't be undone.")) return;
              change.mutate({ status: to });
            }}>
            {ACTION_LABELS[to] ?? to}
          </button>
        ))}
      </div>
      {cancelling && (
        <form className="inline-form" onSubmit={submitCancel} noValidate aria-label="Cancel reservation">
          <TextField label="Reason for cancelling" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} error={fieldErrors(change.error)("reason")} />
          <button className="btn btn-danger" type="submit" disabled={change.isPending}>Confirm cancellation</button>
          <button className="btn" type="button" onClick={() => setCancelling(false)}>Keep reservation</button>
        </form>
      )}
      <div style={{ marginTop: 8 }}><ErrorAlert error={change.error && !fieldErrors(change.error)("reason") ? change.error : null} /></div>
    </div>
  );
}
