import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney, INCIDENT_CATEGORY_LABELS } from "@pawguild/shared";
import { Link, useNavigate } from "react-router";
import { get, invoiceLabel, post, type Invoice, type Reservation, type InvoicePackages } from "../api";
import { useCan } from "../auth";
import { formatTime } from "../units";
import { useStatusChange } from "./StatusActions";
import { PackageToggle } from "./PackageToggle";
import { ErrorAlert, Loading, Panel } from "./ui";

interface CheckoutSummary {
  status: string;
  warnings: string[];
  pets: {
    petId: string; petName: string;
    counts: { feeding: number; medication: number; potty: number; walk: number; play: number; rest: number };
    mealsNotFinished: number;
    medicationsGiven: { name: string; dose: string; status: string; at: string }[];
    notes: { text: string; at: string; by: string }[];
    dosesNotRecorded: { medicationName: string; scheduledFor: string; status: string }[];
    incidents: { id: string; category: string; severity: string; ownerNotified: boolean; resolvedAt: string | null }[];
  }[];
  billing: {
    invoice: { id: string; status: string; number: number | null; totalCents: number; balanceCents: number; paymentStatus: string; packages: InvoicePackages } | null;
    customerCreditCents: number;
  } | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Everything to review before handing a pet back, and the check-out action. */
export function CheckOutPanel({ reservation: r }: { reservation: Reservation }) {
  const canCheckOut = useCan("stays:check_in_out");
  const canBill = useCan("billing:write");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const shown = r.status === "checked_in" || r.status === "completed";
  const summary = useQuery({
    queryKey: ["checkout", r.id, r.status],
    queryFn: () => get<CheckoutSummary>(`/api/reservations/${r.id}/checkout-summary`),
    enabled: shown,
    staleTime: 0, // always fresh: care, incidents and payments change on other pages
  });
  const checkOut = useStatusChange(r.id);
  const createInvoice = useMutation({
    mutationFn: () => post<Invoice>(`/api/reservations/${r.id}/invoice`),
    onSuccess: (inv) => { qc.invalidateQueries({ queryKey: ["reservation", r.id] }); navigate(`/invoices/${inv.id}`); },
  });
  if (!shown) return null;
  const done = r.status === "completed";

  return (
    <Panel title={done ? "Stay summary" : "Check-out"}>
      {summary.isPending ? <Loading /> : summary.error ? <ErrorAlert error={summary.error} /> : (
        <div className="stack">
          {!done && summary.data.warnings.length > 0 && (
            <div className="alert alert-warning" style={{ margin: 0 }} role="status" aria-label="Check-out warnings">
              <strong>Before check-out:</strong>
              <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{summary.data.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
            </div>
          )}
          {summary.data.pets.map((p) => (
            <div key={p.petId}>
              <h3 style={{ marginBottom: 4 }}>{p.petName}</h3>
              <p style={{ margin: 0 }}>
                {/* Only what actually happened; a row of zeros is noise. */}
                {[
                  p.counts.feeding && `Fed ${plural(p.counts.feeding, "time")}${p.mealsNotFinished ? ` (${p.mealsNotFinished} not finished)` : ""}`,
                  p.counts.medication && `${p.counts.medication} medication${p.counts.medication === 1 ? "" : "s"} logged`,
                  p.counts.potty && plural(p.counts.potty, "potty break"),
                  p.counts.walk && plural(p.counts.walk, "walk"),
                  p.counts.play && plural(p.counts.play, "play session"),
                  p.counts.rest && plural(p.counts.rest, "rest"),
                ].filter(Boolean).join(" · ") || <span className="muted">Nothing logged this stay.</span>}
              </p>
              {p.medicationsGiven.length > 0 && (
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  Medication: {p.medicationsGiven.map((m) => `${m.name} ${m.dose} ${m.status} at ${formatTime(m.at)}`).join("; ")}
                </p>
              )}
              {p.dosesNotRecorded.length > 0 && (
                <p style={{ margin: "4px 0 0", color: "var(--danger)" }}>
                  Not recorded today: {p.dosesNotRecorded.map((d) => `${d.medicationName} (${formatTime(d.scheduledFor)})`).join(", ")} ·{" "}
                  <Link to="/care">Today's care</Link>
                </p>
              )}
              {p.incidents.length > 0 && (
                <p style={{ margin: "4px 0 0" }}>
                  Incidents: {p.incidents.map((i, n) => (
                    <span key={i.id}>{n > 0 && ", "}
                      <Link to="/incidents?show=all">{INCIDENT_CATEGORY_LABELS[i.category as keyof typeof INCIDENT_CATEGORY_LABELS] ?? i.category}</Link>
                      {" "}{i.resolvedAt ? "(resolved)" : i.ownerNotified ? "(open, owner told)" : <strong>(owner not told yet)</strong>}
                    </span>
                  ))}
                </p>
              )}
              {p.notes.length > 0 && (
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>{p.notes.map((n, i) => <li key={`${n.at}-${i}`}>“{n.text}” — {n.by}</li>)}</ul>
              )}
            </div>
          ))}

          {summary.data.billing?.invoice && (
            <PackageToggle invoiceId={summary.data.billing.invoice.id} packages={summary.data.billing.invoice.packages} reservationId={r.id} />
          )}
          {summary.data.billing && (
            <div className="estimate" style={{ flexWrap: "wrap" }}>
              {summary.data.billing.invoice ? (
                <>
                  <span><Link to={`/invoices/${summary.data.billing.invoice.id}`}>{invoiceLabel(summary.data.billing.invoice)}</Link> · total {formatMoney(summary.data.billing.invoice.totalCents)}</span>
                  <span>
                    {summary.data.billing.invoice.status === "draft" ? <Link className="btn btn-small" to={`/invoices/${summary.data.billing.invoice.id}`}>Review and issue</Link>
                      : summary.data.billing.invoice.balanceCents > 0 ? <>
                        <strong>{formatMoney(summary.data.billing.invoice.balanceCents)} due</strong>{" "}
                        <Link className="btn btn-small btn-primary" to={`/invoices/${summary.data.billing.invoice.id}`}>Take payment</Link>
                      </> : <span className="badge badge-success">Paid</span>}
                  </span>
                </>
              ) : (
                <>
                  <span>Not invoiced yet{summary.data.billing.customerCreditCents > 0 && ` · ${formatMoney(summary.data.billing.customerCreditCents)} deposit/credit on account`}</span>
                  {canBill && <button className="btn btn-small btn-primary" disabled={createInvoice.isPending} onClick={() => createInvoice.mutate()}>Create invoice</button>}
                </>
              )}
            </div>
          )}
          <ErrorAlert error={createInvoice.error ?? checkOut.error} />
          {!done && canCheckOut && (
            <div>
              <button className="btn btn-primary" disabled={checkOut.isPending} onClick={() => checkOut.mutate({ status: "completed" })}>Check out</button>
              {summary.data.warnings.length > 0 && <span className="muted" style={{ marginLeft: 12 }}>You can still check out; the warnings are for your review.</span>}
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
