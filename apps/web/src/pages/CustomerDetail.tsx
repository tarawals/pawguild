import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { get, post, type Customer } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, StatusBadge } from "../components/ui";
import { History } from "./History";

export function CustomerDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const canWrite = useCan("customers:write");
  const canWritePets = useCan("pets:write");
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
