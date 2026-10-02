import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatBps, formatMoney, parseMoney, parsePercentToBps, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, percentOf, REFUND_METHOD_LABELS,
} from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ApiError, del, get, invoiceLabel, post, type Invoice, type Payment, type Service } from "../api";
import { useCan, useMe } from "../auth";
import { PackageToggle } from "../components/PackageToggle";
import { InvoiceStatusBadge } from "../components/InvoiceStatusBadge";
import { Checkbox, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextField } from "../components/ui";
import { formatDate, formatDateTime } from "../units";

const money = (label: string, path: string, input: string): number => {
  try { return parseMoney(input); } catch {
    throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path, message: `Enter ${label} like 25 or 25.50` }]);
  }
};

/** Every invoice action returns the updated invoice; refresh everything that shows it. */
function useInvoiceUpdated() {
  const qc = useQueryClient();
  return (inv: Invoice) => {
    qc.setQueryData(["invoice", inv.id], inv);
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["customer", inv.customer.id] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    if (inv.reservationId) qc.invalidateQueries({ queryKey: ["reservation", inv.reservationId] });
  };
}

function AddLine({ invoice }: { invoice: Invoice }) {
  const onUpdated = useInvoiceUpdated();
  const services = useQuery({ queryKey: ["services"], queryFn: () => get<{ items: Service[] }>("/api/services") });
  const empty = { serviceId: "", description: "", quantity: "1", price: "", discount: "", discountMode: "amount", taxable: false };
  const [f, setF] = useState(empty);
  const add = useMutation({ onSuccess: onUpdated, mutationFn: () => {
    const quantity = Number(f.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "quantity", message: "Enter a whole number of 1 or more" }]);
    const unitPriceCents = money("a price", "unitPriceCents", f.price || "0");
    let discountCents = 0;
    if (f.discount.trim()) {
      if (f.discountMode === "percent") {
        let bps: number;
        try { bps = parsePercentToBps(f.discount); } catch (e) {
          throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "discountCents", message: (e as Error).message }]);
        }
        discountCents = percentOf(quantity * unitPriceCents, bps);
      } else discountCents = money("a discount", "discountCents", f.discount);
    }
    return post<Invoice>(`/api/invoices/${invoice.id}/lines`, {
      ...(f.serviceId && { serviceId: f.serviceId }), description: f.description, quantity, unitPriceCents, discountCents, taxable: f.taxable,
    });
  } });
  const err = fieldErrors(add.error);
  function chooseService(id: string) {
    const s = services.data?.items.find((x) => x.id === id);
    setF({ ...f, serviceId: id, description: s?.name ?? "", price: s ? (s.priceCents / 100).toFixed(2) : "", taxable: s?.isTaxable ?? false });
  }
  function onSubmit(e: FormEvent) { e.preventDefault(); add.mutate(undefined, { onSuccess: () => setF(empty) }); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label="Add line" style={{ padding: 16, borderTop: "1px solid var(--border)" }}>
      <h3>Add a line</h3>
      <ErrorAlert error={add.error} />
      <div className="form-grid">
        <SelectField label="Service" value={f.serviceId} onChange={(e) => chooseService(e.target.value)}>
          <option value="">Custom item…</option>
          {services.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name} — {formatMoney(s.priceCents)}</option>)}
        </SelectField>
        <TextField label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} error={err("description")} />
        <TextField label="Qty" inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} error={err("quantity")} />
        <TextField label="Unit price ($)" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} error={err("unitPriceCents")} />
        <TextField label={f.discountMode === "percent" ? "Discount (%)" : "Discount ($)"} inputMode="decimal" value={f.discount}
          onChange={(e) => setF({ ...f, discount: e.target.value })} error={err("discountCents")} />
        <SelectField label="Discount type" value={f.discountMode} onChange={(e) => setF({ ...f, discountMode: e.target.value })}>
          <option value="amount">Dollar amount</option><option value="percent">Percent of line</option>
        </SelectField>
        <Checkbox label="Taxable" checked={f.taxable} onChange={(e) => setF({ ...f, taxable: e.target.checked })} />
      </div>
      <div><button className="btn btn-primary btn-small" type="submit" disabled={add.isPending}>Add line</button></div>
    </form>
  );
}

function RecordPayment({ invoice }: { invoice: Invoice }) {
  const onUpdated = useInvoiceUpdated();
  const [amount, setAmount] = useState((invoice.balanceCents / 100).toFixed(2));
  const [method, setMethod] = useState("card");
  const [reference, setReference] = useState("");
  const pay = useMutation({ onSuccess: onUpdated, mutationFn: () => post<Invoice>(`/api/invoices/${invoice.id}/payments`, {
    amountCents: money("an amount", "amountCents", amount), method, reference,
  }) });
  const err = fieldErrors(pay.error);
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    pay.mutate(undefined, { onSuccess: (inv) => { setAmount((inv.balanceCents / 100).toFixed(2)); setReference(""); } });
  }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label="Record payment">
      <ErrorAlert error={pay.error && !err("amountCents") ? pay.error : null} />
      <div className="form-grid">
        <TextField label="Amount ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={err("amountCents")} />
        <SelectField label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>)}
        </SelectField>
        <TextField label="Reference (optional)" hint="e.g. last 4 digits, check number" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
      <div><button className="btn btn-primary" type="submit" disabled={pay.isPending}>Record payment</button></div>
    </form>
  );
}

function ApplyCredit({ invoice }: { invoice: Invoice }) {
  const onUpdated = useInvoiceUpdated();
  const max = Math.min(invoice.customerCreditCents, invoice.balanceCents);
  const [amount, setAmount] = useState((max / 100).toFixed(2));
  const apply = useMutation({ onSuccess: onUpdated, mutationFn: () => post<Invoice>(`/api/invoices/${invoice.id}/apply-credit`, { amountCents: money("an amount", "amountCents", amount) }) });
  return (
    <form className="inline-form" noValidate aria-label="Apply account credit" onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
      <TextField label={`Apply account credit (${formatMoney(invoice.customerCreditCents)} available)`} inputMode="decimal" value={amount}
        onChange={(e) => setAmount(e.target.value)} error={fieldErrors(apply.error)("amountCents")} />
      <button className="btn btn-primary" type="submit" disabled={apply.isPending}>Apply credit</button>
      <ErrorAlert error={apply.error && !fieldErrors(apply.error)("amountCents") ? apply.error : null} />
    </form>
  );
}

function CreditNoteForm({ invoice, onDone }: { invoice: Invoice; onDone: () => void }) {
  const onUpdated = useInvoiceUpdated();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const add = useMutation({ onSuccess: (inv: Invoice) => { onUpdated(inv); onDone(); },
    mutationFn: () => post<Invoice>(`/api/invoices/${invoice.id}/credit-notes`, { amountCents: money("an amount", "amountCents", amount), reason }) });
  const err = fieldErrors(add.error);
  return (
    <form className="stack" noValidate aria-label="Add credit note" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
      <p className="muted" style={{ margin: 0 }}>Reduces what the customer owes without changing the invoice. Include any tax you're crediting.</p>
      <ErrorAlert error={add.error && !err("amountCents") && !err("reason") ? add.error : null} />
      <div className="form-grid">
        <TextField label="Credit amount ($)" inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} error={err("amountCents")} />
        <TextField label="Reason" hint="e.g. Picked up a night early" value={reason} onChange={(e) => setReason(e.target.value)} error={err("reason")} />
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={add.isPending}>Add credit note</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function RefundForm({ invoice }: { invoice: Invoice }) {
  const onUpdated = useInvoiceUpdated();
  const [f, setF] = useState({ amount: (-invoice.balanceCents / 100).toFixed(2), method: "card", reference: "", reason: "" });
  const refund = useMutation({ onSuccess: onUpdated, mutationFn: () => post<Invoice>(`/api/invoices/${invoice.id}/refunds`, {
    amountCents: money("an amount", "amountCents", f.amount), method: f.method, reference: f.reference, reason: f.reason,
  }) });
  const err = fieldErrors(refund.error);
  return (
    <form className="stack" noValidate aria-label="Refund overpayment" onSubmit={(e) => { e.preventDefault(); refund.mutate(); }}>
      <ErrorAlert error={refund.error && !err("amountCents") && !err("reason") ? refund.error : null} />
      <div className="form-grid">
        <TextField label="Amount ($)" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} error={err("amountCents")} />
        <SelectField label="Refund to" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
          {(["card", "cash", "check", "other", "account_credit"] as const).map((m) => <option key={m} value={m}>{REFUND_METHOD_LABELS[m]}</option>)}
        </SelectField>
        {f.method !== "account_credit" && <TextField label="Reference (optional)" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />}
        <TextField label="Reason" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} error={err("reason")} />
      </div>
      <div><button className="btn btn-primary" type="submit" disabled={refund.isPending}>{f.method === "account_credit" ? "Move to account credit" : "Record refund"}</button></div>
    </form>
  );
}

function ReasonForm({ label, button, onSubmit, pending, error, onCancel }: {
  label: string; button: string; onSubmit: (reason: string) => void; pending: boolean; error: unknown; onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); onSubmit(reason); }} aria-label={button}>
      <TextField label={label} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} error={fieldErrors(error)("reason")} />
      <button className="btn btn-danger btn-small" type="submit" disabled={pending}>{button}</button>
      <button className="btn btn-small" type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function PaymentRow({ p, voidable }: { p: Payment; voidable: boolean }) {
  const canVoid = useCan("billing:refund") && voidable;
  const onUpdated = useInvoiceUpdated();
  const [voiding, setVoiding] = useState(false);
  const voidPayment = useMutation({ onSuccess: onUpdated, mutationFn: (reason: string) => post<Invoice>(`/api/payments/${p.id}/void`, { reason }) });
  return (
    <tr style={p.voidedAt ? { opacity: 0.6 } : undefined}>
      <td>{formatDateTime(p.receivedAt)}</td>
      <td>{REFUND_METHOD_LABELS[p.method as keyof typeof REFUND_METHOD_LABELS] ?? p.method}{p.reference && p.method !== "account_credit" && <span className="muted"> · {p.reference}</span>}</td>
      <td>{p.recordedBy}{p.voidedAt && <div style={{ color: "var(--danger)" }}>Voided: {p.voidReason}</div>}</td>
      <td style={{ textAlign: "right", textDecoration: p.voidedAt ? "line-through" : undefined }}>{formatMoney(p.amountCents)}</td>
      <td className="row-actions">
        {canVoid && !p.voidedAt && !voiding && <button className="btn btn-small" onClick={() => setVoiding(true)} aria-label={`Void payment of ${formatMoney(p.amountCents)}`}>Void</button>}
        {voiding && <ReasonForm label="Reason" button="Void payment" pending={voidPayment.isPending} error={voidPayment.error}
          onSubmit={(r) => voidPayment.mutate(r, { onSuccess: () => setVoiding(false) })} onCancel={() => setVoiding(false)} />}
      </td>
    </tr>
  );
}

export function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const canWrite = useCan("billing:write");
  const canVoidIssued = useCan("billing:refund");
  const canRefund = canVoidIssued;
  const me = useMe();
  const [crediting, setCrediting] = useState(false);
  const onUpdated = useInvoiceUpdated();
  const [voiding, setVoiding] = useState(false);
  const invoice = useQuery({ queryKey: ["invoice", id], queryFn: () => get<Invoice>(`/api/invoices/${id}`) });
  const issue = useMutation({ onSuccess: onUpdated, mutationFn: () => post<Invoice>(`/api/invoices/${id}/issue`) });
  const removeLine = useMutation({ onSuccess: onUpdated, mutationFn: (lineId: string) => del<Invoice>(`/api/invoices/${id}/lines/${lineId}`) });
  const voidInvoice = useMutation({ onSuccess: onUpdated, mutationFn: (reason: string) => post<Invoice>(`/api/invoices/${id}/void`, { reason }) });

  if (invoice.isPending) return <Loading />;
  if (invoice.error) return <ErrorAlert error={invoice.error} />;
  const inv = invoice.data;
  const draft = inv.status === "draft";
  const canVoid = draft ? canWrite : inv.status === "issued" && canVoidIssued;

  return (
    <>
      <div className="print-only" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: "1.2rem" }}>{me.organization.name}</strong>
        <div>{inv.location.name}</div>
        <div>Bill to: {inv.customer.firstName} {inv.customer.lastName}{inv.customer.email && ` · ${inv.customer.email}`}{inv.customer.phone && ` · ${inv.customer.phone}`}</div>
      </div>
      <PageHeader
        breadcrumb={<Link to="/invoices">Invoices</Link>}
        title={<>{invoiceLabel(inv)} <InvoiceStatusBadge status={inv.status} balanceCents={inv.balanceCents} paidCents={inv.paidCents} /></>}
        description={<><Link to={`/customers/${inv.customer.id}`}>{inv.customer.firstName} {inv.customer.lastName}</Link> · {inv.location.name}
          {inv.issuedAt && ` · issued ${formatDate(inv.issuedAt.slice(0, 10))}`}
          {inv.reservationId && <> · <Link to={`/reservations/${inv.reservationId}`}>View reservation</Link></>}</>}
        actions={<div className="actions no-print">
          {draft && canWrite && <button className="btn btn-primary" disabled={issue.isPending || inv.lines.length === 0} onClick={() => issue.mutate()}>Issue invoice</button>}
          <button className="btn" onClick={() => window.print()}>Print</button>
          {canVoid && !voiding && <button className="btn btn-danger" onClick={() => setVoiding(true)}>{draft ? "Discard draft" : "Void invoice"}</button>}
        </div>}
      />
      <ErrorAlert error={issue.error ?? removeLine.error} />
      {voiding && (
        <div className="alert alert-warning">
          <ReasonForm label={draft ? "Why discard this draft?" : "Why void this invoice?"} button={draft ? "Discard draft" : "Void invoice"}
            pending={voidInvoice.isPending} error={voidInvoice.error}
            onSubmit={(r) => voidInvoice.mutate(r, { onSuccess: () => setVoiding(false) })} onCancel={() => setVoiding(false)} />
          <ErrorAlert error={voidInvoice.error && !fieldErrors(voidInvoice.error)("reason") ? voidInvoice.error : null} />
        </div>
      )}
      {inv.status === "void" && <div className="alert alert-warning">Void: {inv.voidReason}</div>}
      {draft && <div className="alert alert-warning no-print">This is a draft. Check the lines, then issue it to lock the amounts and assign an invoice number.</div>}

      <div className="stack">
        <Panel title="Charges" bodyless>
          {(inv.packages.daysUsed > 0 || inv.packages.canChange) && (
            <div className="panel-body no-print" style={{ paddingBottom: 0 }}>
              <PackageToggle invoiceId={inv.id} packages={inv.packages} reservationId={inv.reservationId} />
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Description</th><th scope="col" style={{ textAlign: "right" }}>Qty</th>
                <th scope="col" style={{ textAlign: "right" }}>Unit price</th><th scope="col" style={{ textAlign: "right" }}>Discount</th>
                <th scope="col" style={{ textAlign: "right" }}>Amount</th>{draft && canWrite && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
              <tbody>
                {inv.lines.length === 0 && <tr><td colSpan={6} className="muted">No lines yet.</td></tr>}
                {inv.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.description}{l.taxable && <span className="muted"> · taxable</span>}</td>
                    <td style={{ textAlign: "right" }}>{l.quantity}</td>
                    <td style={{ textAlign: "right" }}>{formatMoney(l.unitPriceCents)}</td>
                    <td style={{ textAlign: "right" }}>{l.discountCents ? `−${formatMoney(l.discountCents)}` : "—"}</td>
                    <td style={{ textAlign: "right" }}>{formatMoney(l.amountCents)}</td>
                    {draft && canWrite && <td className="row-actions"><button className="btn btn-small" disabled={removeLine.isPending}
                      onClick={() => removeLine.mutate(l.id)} aria-label={`Remove ${l.description}`}>Remove</button></td>}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Subtotal</th><td style={{ textAlign: "right" }}>{formatMoney(inv.totals.subtotalCents)}</td></tr>
                {inv.totals.discountCents > 0 && <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Discounts</th><td style={{ textAlign: "right" }}>−{formatMoney(inv.totals.discountCents)}</td></tr>}
                <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Sales tax ({formatBps(inv.taxRateBps)} on {formatMoney(inv.totals.taxableCents)})</th><td style={{ textAlign: "right" }}>{formatMoney(inv.totals.taxCents)}</td></tr>
                <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Total</th><td style={{ textAlign: "right" }}><strong>{formatMoney(inv.totals.totalCents)}</strong></td></tr>
                {inv.status === "issued" && <>
                  {inv.creditNotesCents > 0 && <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Credit notes</th><td style={{ textAlign: "right" }}>−{formatMoney(inv.creditNotesCents)}</td></tr>}
                  <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Paid{inv.refundsCents > 0 && " (after refunds)"}</th><td style={{ textAlign: "right" }}>{formatMoney(inv.paidCents)}</td></tr>
                  {inv.balanceCents < 0
                    ? <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Owed back to customer</th><td style={{ textAlign: "right" }}><strong style={{ color: "var(--warning)" }}>{formatMoney(-inv.balanceCents)}</strong></td></tr>
                    : <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Balance due</th><td style={{ textAlign: "right" }}><strong>{formatMoney(inv.balanceCents)}</strong></td></tr>}
                </>}
              </tfoot>
            </table>
          </div>
          {draft && canWrite && <div className="no-print"><AddLine invoice={inv} /></div>}
        </Panel>
        {inv.status !== "draft" && (
          <Panel title="Payments" bodyless>
            {inv.payments.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Received</th><th scope="col">Method</th><th scope="col">Recorded by</th><th scope="col" style={{ textAlign: "right" }}>Amount</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>{inv.payments.map((p) => <PaymentRow key={p.id} p={p} voidable={inv.refunds.length === 0} />)}</tbody>
                </table>
              </div>
            )}
            {inv.status === "issued" && inv.balanceCents > 0 && canWrite && (
              <div className="panel-body no-print stack">
                {/* Keyed by balance so the suggested amounts refresh after every payment, credit or refund. */}
                {inv.customerCreditCents > 0 && <ApplyCredit key={`credit-${inv.balanceCents}-${inv.customerCreditCents}`} invoice={inv} />}
                <RecordPayment key={`pay-${inv.balanceCents}`} invoice={inv} />
              </div>
            )}
            {inv.payments.length === 0 && !(inv.status === "issued" && canWrite) && <p className="panel-body muted" style={{ margin: 0 }}>No payments.</p>}
          </Panel>
        )}
        {inv.status === "issued" && (inv.creditNotes.length > 0 || inv.refunds.length > 0 || canRefund) && (
          <Panel title="Credits and refunds" bodyless
            actions={canRefund && !crediting && inv.totals.totalCents - inv.creditNotesCents > 0 && <button className="btn btn-small no-print" onClick={() => setCrediting(true)}>Add credit note</button>}>
            {(inv.creditNotes.length > 0 || inv.refunds.length > 0) && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">By</th><th scope="col" style={{ textAlign: "right" }}>Amount</th></tr></thead>
                  <tbody>
                    {inv.creditNotes.map((c) => (
                      <tr key={c.id}><td>{formatDateTime(c.createdAt)}</td><td>Credit note — {c.reason}</td><td>{c.createdBy}</td><td style={{ textAlign: "right" }}>−{formatMoney(c.amountCents)}</td></tr>
                    ))}
                    {inv.refunds.map((r) => (
                      <tr key={r.id}><td>{formatDateTime(r.refundedAt)}</td>
                        <td>{r.method === "account_credit" ? "Moved to account credit" : `Refund (${REFUND_METHOD_LABELS[r.method as keyof typeof REFUND_METHOD_LABELS] ?? r.method}${r.reference ? ` · ${r.reference}` : ""})`} — {r.reason}</td>
                        <td>{r.recordedBy}</td><td style={{ textAlign: "right" }}>{formatMoney(r.amountCents)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {crediting && <div className="panel-body no-print"><CreditNoteForm invoice={inv} onDone={() => setCrediting(false)} /></div>}
            {inv.balanceCents < 0 && (
              <div className="panel-body no-print">
                <div className="alert alert-warning" style={{ marginBottom: 12 }}>The customer has overpaid by {formatMoney(-inv.balanceCents)}. {canRefund ? "Refund it or move it to their account credit." : "A manager needs to refund it or move it to account credit."}</div>
                {canRefund && <RefundForm key={`refund-${inv.balanceCents}`} invoice={inv} />}
              </div>
            )}
            {!crediting && inv.creditNotes.length === 0 && inv.refunds.length === 0 && inv.balanceCents >= 0 && (
              <p className="panel-body muted" style={{ margin: 0 }}>Use a credit note if the customer should pay less than invoiced.</p>
            )}
          </Panel>
        )}
      </div>
    </>
  );
}
