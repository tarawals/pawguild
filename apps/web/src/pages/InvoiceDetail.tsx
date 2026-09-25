import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatBps, formatMoney, parseMoney, parsePercentToBps, PAYMENT_METHOD_LABELS, PAYMENT_METHODS, percentOf,
} from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { ApiError, del, get, invoiceLabel, post, type Invoice, type Payment, type Service } from "../api";
import { useCan, useMe } from "../auth";
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

function PaymentRow({ p }: { p: Payment }) {
  const canVoid = useCan("billing:refund");
  const onUpdated = useInvoiceUpdated();
  const [voiding, setVoiding] = useState(false);
  const voidPayment = useMutation({ onSuccess: onUpdated, mutationFn: (reason: string) => post<Invoice>(`/api/payments/${p.id}/void`, { reason }) });
  return (
    <tr style={p.voidedAt ? { opacity: 0.6 } : undefined}>
      <td>{formatDateTime(p.receivedAt)}</td>
      <td>{PAYMENT_METHOD_LABELS[p.method as keyof typeof PAYMENT_METHOD_LABELS] ?? p.method}{p.reference && <span className="muted"> · {p.reference}</span>}</td>
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
  const me = useMe();
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
                  <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Paid</th><td style={{ textAlign: "right" }}>{formatMoney(inv.paidCents)}</td></tr>
                  <tr><th scope="row" colSpan={4} style={{ textAlign: "right" }}>Balance due</th><td style={{ textAlign: "right" }}><strong>{formatMoney(inv.balanceCents)}</strong></td></tr>
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
                  <tbody>{inv.payments.map((p) => <PaymentRow key={p.id} p={p} />)}</tbody>
                </table>
              </div>
            )}
            {inv.status === "issued" && inv.balanceCents > 0 && canWrite && <div className="panel-body no-print"><RecordPayment invoice={inv} /></div>}
            {inv.payments.length === 0 && !(inv.status === "issued" && canWrite) && <p className="panel-body muted" style={{ margin: 0 }}>No payments.</p>}
          </Panel>
        )}
      </div>
    </>
  );
}
