import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney, parseMoney, PAYMENT_METHOD_LABELS, PAYMENT_METHODS } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, get, invoiceLabel, post, type CreditEntry } from "../api";
import { useCan } from "../auth";
import { formatDateTime } from "../units";
import { ErrorAlert, fieldErrors, Panel, SelectField, TextField } from "./ui";

const KIND_LABELS: Record<CreditEntry["kind"], string> = {
  received: "Received", from_invoice: "Overpayment moved to credit", reversal: "Credit payment voided",
  applied: "Applied to", refunded: "Refunded to customer",
};

const toCents = (v: string) => {
  try { return parseMoney(v); } catch {
    throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "amountCents", message: "Enter an amount like 50 or 49.99" }]);
  }
};

/** Take money on account (a deposit or prepayment). Used on customers and reservations. */
export function ReceiveCreditForm({ customerId, reservationId, label, onDone }: { customerId: string; reservationId?: string; label: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ amount: "", method: "card", reference: "", note: "" });
  const receive = useMutation({
    mutationFn: () => post(`/api/customers/${customerId}/credits`, {
      amountCents: toCents(f.amount), method: f.method, reference: f.reference, note: f.note, ...(reservationId && { reservationId }),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["credits", customerId] });
      qc.invalidateQueries({ queryKey: ["customer", customerId] });
      if (reservationId) qc.invalidateQueries({ queryKey: ["reservation", reservationId] });
      onDone();
    },
  });
  const err = fieldErrors(receive.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); receive.mutate(); }
  return (
    <form className="stack" noValidate onSubmit={onSubmit} aria-label={label}>
      <ErrorAlert error={receive.error && !err("amountCents") ? receive.error : null} />
      <div className="form-grid">
        <TextField label="Amount ($)" inputMode="decimal" autoFocus value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={err("amountCents")} />
        <SelectField label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
        </SelectField>
        <TextField label="Reference (optional)" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        <TextField label="Note (optional)" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={receive.isPending}>{label}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function RefundCreditForm({ customerId, available, onDone }: { customerId: string; available: number; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ amount: (available / 100).toFixed(2), method: "card", reference: "", reason: "" });
  const refund = useMutation({
    mutationFn: () => post(`/api/customers/${customerId}/credits/refund`, { amountCents: toCents(f.amount), method: f.method, reference: f.reference, reason: f.reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["credits", customerId] }); qc.invalidateQueries({ queryKey: ["customer", customerId] }); onDone(); },
  });
  const err = fieldErrors(refund.error);
  return (
    <form className="stack" noValidate aria-label="Refund account credit" onSubmit={(e) => { e.preventDefault(); refund.mutate(); }}>
      <ErrorAlert error={refund.error && !err("amountCents") && !err("reason") ? refund.error : null} />
      <div className="form-grid">
        <TextField label="Amount ($)" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={err("amountCents")} />
        <SelectField label="Refund by" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
        </SelectField>
        <TextField label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={err("reason")} />
      </div>
      <div className="actions">
        <button className="btn btn-danger" type="submit" disabled={refund.isPending}>Refund credit</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function AccountCreditPanel({ customerId }: { customerId: string }) {
  const canWrite = useCan("billing:write");
  const canRefund = useCan("billing:refund");
  const [mode, setMode] = useState<"receive" | "refund" | null>(null);
  const credits = useQuery({
    queryKey: ["credits", customerId],
    queryFn: () => get<{ balanceCents: number; entries: CreditEntry[] }>(`/api/customers/${customerId}/credits`),
  });
  const balance = credits.data?.balanceCents ?? 0;
  return (
    <Panel title={<>Account credit <span className={`badge ${balance > 0 ? "badge-info" : ""}`}>{formatMoney(balance)}</span></>} bodyless
      actions={mode === null && <div className="actions">
        {canWrite && <button className="btn btn-small" onClick={() => setMode("receive")}>Take deposit / prepayment</button>}
        {canRefund && balance > 0 && <button className="btn btn-small" onClick={() => setMode("refund")}>Refund credit</button>}
      </div>}>
      <ErrorAlert error={credits.error} />
      {mode === "receive" && <div className="panel-body"><ReceiveCreditForm customerId={customerId} label="Add to account" onDone={() => setMode(null)} /></div>}
      {mode === "refund" && <div className="panel-body"><RefundCreditForm customerId={customerId} available={balance} onDone={() => setMode(null)} /></div>}
      {credits.data && credits.data.entries.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col" style={{ textAlign: "right" }}>Amount</th></tr></thead>
            <tbody>{credits.data.entries.map((e) => (
              <tr key={e.id}>
                <td>{formatDateTime(e.createdAt)}</td>
                <td>
                  {KIND_LABELS[e.kind]}
                  {e.kind === "received" && ` (${PAYMENT_METHOD_LABELS[e.method as keyof typeof PAYMENT_METHOD_LABELS] ?? e.method}${e.reservationId ? ", deposit" : ""})`}
                  {e.invoiceId && <> {e.kind === "applied" ? "" : "· "}<Link to={`/invoices/${e.invoiceId}`}>{invoiceLabel({ number: e.invoiceNumber, status: "issued" })}</Link></>}
                  {e.reservationId && <> · <Link to={`/reservations/${e.reservationId}`}>reservation</Link></>}
                  {e.note && <div className="muted">{e.note}</div>}
                  <div className="muted" style={{ fontSize: "0.85rem" }}>{e.recordedBy}</div>
                </td>
                <td style={{ textAlign: "right" }}>{e.amountCents > 0 ? "+" : "−"}{formatMoney(Math.abs(e.amountCents))}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : mode === null && <p className="panel-body muted" style={{ margin: 0 }}>No deposits or credit on file.</p>}
    </Panel>
  );
}
