import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "@pawguild/shared";
import { useState } from "react";
import { ReceiveCreditForm } from "./AccountCredit";
import { Link, useNavigate } from "react-router";
import { ApiError, invoiceLabel, post, type Invoice, type Reservation } from "../api";
import { useCan } from "../auth";
import { ErrorAlert, Panel } from "./ui";

/** Invoice link for a reservation, or a one-click draft priced at the booked rate. */
export function BillingPanel({ reservation: r }: { reservation: Reservation }) {
  const canRead = useCan("billing:read");
  const canWrite = useCan("billing:write");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [takingDeposit, setTakingDeposit] = useState(false);
  const create = useMutation({
    mutationFn: () => post<Invoice>(`/api/reservations/${r.id}/invoice`),
    onSuccess: (inv) => { qc.invalidateQueries({ queryKey: ["reservation", r.id] }); navigate(`/invoices/${inv.id}`); },
    onError: (err) => {
      const existing = err instanceof ApiError && err.code === "invoice_exists" ? (err as ApiError & { details?: { invoiceId?: string } }) : null;
      if (existing) qc.invalidateQueries({ queryKey: ["reservation", r.id] });
    },
  });
  if (!canRead) return null;
  const billable = r.status !== "cancelled" && r.status !== "no_show";
  return (
    <Panel title="Billing" actions={canWrite && billable && !takingDeposit && !r.invoice && <button className="btn btn-small" onClick={() => setTakingDeposit(true)}>Take deposit</button>}>
      {r.depositsCents > 0 && <p style={{ margin: "0 0 8px" }}>Deposit received: <strong>{formatMoney(r.depositsCents)}</strong> <span className="muted">(held as account credit; apply it on the invoice)</span></p>}
      {takingDeposit && <div style={{ marginBottom: 12 }}><ReceiveCreditForm customerId={r.customer.id} reservationId={r.id} label="Record deposit" onDone={() => setTakingDeposit(false)} /></div>}
      {r.invoice ? (
        <p style={{ margin: 0 }}><Link to={`/invoices/${r.invoice.id}`}>{invoiceLabel(r.invoice)}</Link></p>
      ) : billable && canWrite ? (
        <>
          <ErrorAlert error={create.error} />
          <button className="btn btn-primary btn-small" disabled={create.isPending} onClick={() => create.mutate()}>Create invoice</button>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: "0.875rem" }}>Starts a draft with this stay at the booked rate. Add extras before issuing.</p>
        </>
      ) : <p className="muted" style={{ margin: 0 }}>Not invoiced.</p>}
    </Panel>
  );
}
