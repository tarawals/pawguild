import { useQuery } from "@tanstack/react-query";
import { formatMoney } from "@pawguild/shared";
import { Link, useSearchParams } from "react-router";
import { get, invoiceLabel, type InvoiceListItem } from "../api";
import { InvoiceStatusBadge } from "../components/InvoiceStatusBadge";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel } from "../components/ui";
import { formatDate } from "../units";

const FILTERS = [["unpaid", "Unpaid"], ["draft", "Drafts"], ["paid", "Paid"], ["void", "Void"], ["", "All"]] as const;

export function InvoicesPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "unpaid";
  const list = useQuery({
    queryKey: ["invoices", status],
    queryFn: () => get<{ items: InvoiceListItem[] }>(`/api/invoices${status ? `?status=${status}` : ""}`),
  });
  const outstanding = status === "unpaid" ? list.data?.items.reduce((n, i) => n + i.balanceCents, 0) : undefined;
  return (
    <>
      <PageHeader title="Invoices" description={outstanding !== undefined ? `${formatMoney(outstanding)} outstanding` : "Charges and payments."}
        actions={<div className="actions" role="group" aria-label="Filter invoices">
          {FILTERS.map(([v, label]) => (
            <button key={v} className={`btn btn-small ${status === v ? "btn-primary" : ""}`} aria-pressed={status === v}
              onClick={() => setParams(v ? { status: v } : { status: "" })}>{label}</button>
          ))}
        </div>} />
      <ErrorAlert error={list.error} />
      <Panel bodyless>
        {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && list.data.items.length === 0
          ? <EmptyState title="No invoices here">Create invoices from a reservation or a customer's page.</EmptyState>
          : list.data && (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Date</th>
                  <th scope="col" style={{ textAlign: "right" }}>Total</th><th scope="col" style={{ textAlign: "right" }}>Balance</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {list.data.items.map((i) => (
                    <tr key={i.id}>
                      <td><Link to={`/invoices/${i.id}`}>{invoiceLabel(i)}</Link></td>
                      <td><Link to={`/customers/${i.customerId}`}>{i.customerName}</Link></td>
                      <td>{formatDate((i.issuedAt ?? i.createdAt).slice(0, 10))}</td>
                      <td style={{ textAlign: "right" }}>{formatMoney(Number(i.totalCents))}</td>
                      <td style={{ textAlign: "right" }}>{i.status === "issued" ? formatMoney(i.balanceCents) : "—"}</td>
                      <td><InvoiceStatusBadge status={i.status} balanceCents={i.balanceCents} paidCents={Number(i.paidCents)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
    </>
  );
}
