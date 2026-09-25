import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { formatMoney } from "@pawguild/shared";
import { get, invoiceLabel, post, type Customer, type Invoice, type InvoiceListItem, type Location, type ReservationListItem } from "../api";
import { InvoiceStatusBadge } from "../components/InvoiceStatusBadge";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, ReservationStatusBadge, StatusBadge } from "../components/ui";
import { formatRange } from "../units";
import { History } from "./History";

function CustomerReservations({ customerId, canBook }: { customerId: string; canBook: boolean }) {
  const list = useQuery({
    queryKey: ["reservations", "customer", customerId],
    queryFn: () => get<{ items: ReservationListItem[] }>(`/api/reservations?customerId=${customerId}&from=${encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString())}`),
  });
  return (
    <Panel title="Reservations" actions={canBook && <Link className="btn btn-small btn-primary" to={`/reservations/new?customerId=${customerId}`}>New reservation</Link>} bodyless>
      {list.isPending ? <div className="panel-body"><Loading /></div> : list.error ? <div className="panel-body"><ErrorAlert error={list.error} /></div> :
        list.data.items.length === 0 ? <EmptyState title="No current or upcoming reservations" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">When</th><th scope="col">Pets</th><th scope="col">Service</th><th scope="col">Status</th></tr></thead>
              <tbody>{list.data.items.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/reservations/${r.id}`}>{formatRange(r.startsAt, r.endsAt)}</Link></td>
                  <td>{r.petNames.join(", ")}</td><td>{r.serviceName}</td><td><ReservationStatusBadge status={r.status} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

function CustomerInvoices({ customer }: { customer: Customer }) {
  const canWrite = useCan("billing:write");
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["invoices", "customer", customer.id],
    queryFn: () => get<{ items: InvoiceListItem[] }>(`/api/invoices?customerId=${customer.id}&limit=20`),
  });
  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations"), enabled: canWrite });
  const create = useMutation({
    mutationFn: () => post<Invoice>("/api/invoices", { customerId: customer.id, locationId: locations.data!.items[0]!.id }),
    onSuccess: (inv) => navigate(`/invoices/${inv.id}`),
  });
  return (
    <Panel title={<>Billing {customer.balanceCents ? <span className="badge badge-danger">{formatMoney(customer.balanceCents)} due</span> : <span className="badge badge-success">No balance</span>}</>} bodyless
      actions={canWrite && !customer.archivedAt && <button className="btn btn-small" disabled={create.isPending || !locations.data?.items.length} onClick={() => create.mutate()}>New invoice</button>}>
      <ErrorAlert error={create.error} />
      {list.isPending ? <div className="panel-body"><Loading /></div> : list.error ? <div className="panel-body"><ErrorAlert error={list.error} /></div> :
        list.data.items.length === 0 ? <EmptyState title="No invoices yet" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Invoice</th><th scope="col" style={{ textAlign: "right" }}>Total</th><th scope="col">Status</th></tr></thead>
              <tbody>{list.data.items.map((i) => (
                <tr key={i.id}>
                  <td><Link to={`/invoices/${i.id}`}>{invoiceLabel(i)}</Link></td>
                  <td style={{ textAlign: "right" }}>{formatMoney(Number(i.totalCents))}</td>
                  <td><InvoiceStatusBadge status={i.status} balanceCents={i.balanceCents} paidCents={Number(i.paidCents)} /></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}

export function CustomerDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const canWrite = useCan("customers:write");
  const canWritePets = useCan("pets:write");
  const canBook = useCan("reservations:write");
  const customer = useQuery({ queryKey: ["customer", id], queryFn: () => get<Customer>(`/api/customers/${id}`) });
  const archive = useMutation({
    mutationFn: (action: "archive" | "restore") => post<Customer>(`/api/customers/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer", id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });

  if (customer.isPending) return <Loading />;
  if (customer.error) return <ErrorAlert error={customer.error} />;
  const c = customer.data;
  const archived = Boolean(c.archivedAt);
  const address = [c.addressLine1, c.addressLine2, [c.city, c.region, c.postalCode].filter(Boolean).join(", "), c.country].filter(Boolean).join("\n");

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/customers">Customers</Link>}
        title={<>{c.firstName} {c.lastName} <StatusBadge status={c.status} archived={archived} /></>}
        actions={canWrite && (
          <>
            {!archived && <Link className="btn" to={`/customers/${c.id}/edit`}>Edit</Link>}
            {archived ? (
              <button className="btn" onClick={() => archive.mutate("restore")} disabled={archive.isPending}>Restore</button>
            ) : (
              <button className="btn btn-danger" disabled={archive.isPending} onClick={() => {
                if (window.confirm(`Archive ${c.firstName} ${c.lastName}? They will be hidden from searches. Their records and history are kept and they can be restored.`)) archive.mutate("archive");
              }}>Archive</button>
            )}
          </>
        )}
      />
      <ErrorAlert error={archive.error} />
      {archived && <div className="alert alert-warning">This customer is archived. Restore them to make changes or add pets.</div>}
      <div className="grid-2">
        <div className="stack">
          <Panel title="Pets" actions={canWritePets && !archived && <Link className="btn btn-small btn-primary" to={`/customers/${c.id}/pets/new`}>Add pet</Link>} bodyless>
            {c.pets && c.pets.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Name</th><th scope="col">Species / breed</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    {c.pets.map((p) => (
                      <tr key={p.id}>
                        <td><Link to={`/pets/${p.id}`}>{p.name}</Link></td>
                        <td>{[p.species.charAt(0).toUpperCase() + p.species.slice(1), p.breed].filter(Boolean).join(" · ")}</td>
                        <td><StatusBadge status={p.status} archived={!!p.archivedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No pets yet">Add this customer's pets to start booking stays.</EmptyState>}
          </Panel>
          {c.balanceCents !== null && c.balanceCents !== undefined && <CustomerInvoices customer={c} />}
          <CustomerReservations customerId={c.id} canBook={canBook && !archived && c.status !== "banned"} />
          <History entityType="customer" entityId={c.id} />
        </div>
        <div className="stack">
          <Panel title="Contact">
            <dl className="details">
              <dt>Mobile</dt><dd>{c.phone ?? "—"}</dd>
              <dt>Alternate</dt><dd>{c.altPhone ?? "—"}</dd>
              <dt>Email</dt><dd>{c.email ?? "—"}</dd>
              <dt>Address</dt><dd>{address || "—"}</dd>
              <dt>Emergency</dt><dd>{c.emergencyContactName ? `${c.emergencyContactName}${c.emergencyContactPhone ? ` · ${c.emergencyContactPhone}` : ""}` : "—"}</dd>
              <dt>Updates</dt><dd>{[c.emailOptIn && "Email", c.smsOptIn && "Text"].filter(Boolean).join(", ") || "None"}</dd>
            </dl>
          </Panel>
          <Panel title="Notes"><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{c.notes ?? <span className="muted">No notes.</span>}</p></Panel>
        </div>
      </div>
    </>
  );
}
