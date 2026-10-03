import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney } from "@pawguild/shared";
import { useState } from "react";
import { Link } from "react-router";
import { get, post } from "../api";
import { useCan } from "../auth";
import { MembershipStatus, monthLeft, type Membership } from "../components/Memberships";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel } from "../components/ui";
import { formatDate } from "../units";

interface BillResult { billed: { customerName: string; membership: string; periodStart: string; periodEnd: string; invoiceId: string }[] }

export function MembershipsPage() {
  const qc = useQueryClient();
  const canWrite = useCan("billing:write");
  const [showEnded, setShowEnded] = useState(false);
  const [result, setResult] = useState<BillResult | null>(null);
  const list = useQuery({ queryKey: ["memberships"], queryFn: () => get<{ items: (Membership & { customerName: string })[]; dueCount: number }>("/api/memberships") });
  const bill = useMutation({
    mutationFn: () => post<BillResult>("/api/memberships/bill-due"),
    onSuccess: (r) => {
      setResult(r);
      qc.invalidateQueries({ queryKey: ["memberships"] }); qc.invalidateQueries({ queryKey: ["customer-memberships"] }); qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
  const items = (list.data?.items ?? []).filter((m) => showEnded || m.status !== "ended");
  const due = list.data?.dueCount ?? 0;
  const monthly = (list.data?.items ?? []).filter((m) => m.status === "active" || m.status === "upcoming").reduce((n, m) => n + m.priceCents, 0);
  return (
    <>
      <PageHeader title="Memberships"
        description={list.data ? `${(list.data.items ?? []).filter((m) => m.status === "active").length} active · ${formatMoney(monthly)} a month${due ? ` · ${due} due to be billed` : ""}` : "Monthly memberships."}
        actions={canWrite && <button className="btn btn-primary" disabled={bill.isPending || due === 0} onClick={() => { setResult(null); bill.mutate(); }}>
          {bill.isPending ? "Billing…" : `Bill due memberships${due ? ` (${due})` : ""}`}
        </button>} />
      <ErrorAlert error={list.error ?? bill.error} />
      {result && (
        <div role="status" className="alert alert-warning">
          {result.billed.length === 0 ? "Nothing was due." : <>Billed {result.billed.length} month{result.billed.length === 1 ? "" : "s"}:{" "}
            {result.billed.map((b, i) => <span key={b.invoiceId}>{i > 0 && "; "}<Link to={`/invoices/${b.invoiceId}`}>{b.customerName} — {b.membership}, {formatDate(b.periodStart)}</Link></span>)}.
            Collect payment on each invoice.</>}
        </div>
      )}
      {list.isPending ? <Loading /> : (
        <Panel bodyless title="All memberships" actions={<label className="muted" style={{ fontSize: "0.875rem" }}><input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} style={{ width: 16, minHeight: 16, marginRight: 6 }} />Show ended</label>}>
          {items.length === 0 ? <EmptyState title="No memberships yet">Sign customers up from their page.</EmptyState> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Customer</th><th scope="col">Plan</th><th scope="col">Status</th><th scope="col">This month</th><th scope="col">Next bill</th></tr></thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.id}>
                      <td><Link to={`/customers/${m.customerId}`}>{m.customerName}</Link></td>
                      <td>{m.name} · {formatMoney(m.priceCents)}/mo</td>
                      <td><MembershipStatus m={m} /></td>
                      <td>{m.status === "ended" ? "—" : monthLeft(m)}</td>
                      <td>{m.nextBillOn ? <>{formatDate(m.nextBillOn)}{m.due && <span className="badge badge-warning" style={{ marginLeft: 6 }}>Due</span>}</>
                        : m.endsOn ? `Ends ${formatDate(m.endsOn)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
