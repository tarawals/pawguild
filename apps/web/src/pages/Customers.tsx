import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { get, type CustomerListItem } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, StatusBadge } from "../components/ui";

const PAGE_SIZE = 50;

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const page = Number(params.get("page") ?? "0");
  const [draft, setDraft] = useState(q);
  const canWrite = useCan("customers:write");

  // Debounce typing into the URL so search results are shareable and back-button friendly.
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== q) setParams(draft ? { q: draft } : {}, { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [draft, q, setParams]);

  const list = useQuery({
    queryKey: ["customers", q, page],
    queryFn: () => get<{ items: CustomerListItem[]; total: number }>(
      `/api/customers?${new URLSearchParams({ q, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })}`,
    ),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader
        title="Customers"
        description="Pet owners and their contact details."
        actions={canWrite && <Link className="btn btn-primary" to="/customers/new">New customer</Link>}
      />
      <div className="field search" style={{ marginBottom: 16 }}>
        <label htmlFor="customer-search">Search customers</label>
        <input id="customer-search" type="search" placeholder="Name, email, phone or pet name" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <ErrorAlert error={list.error} />
      <Panel bodyless>
        {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && list.data.items.length === 0 ? (
          <EmptyState title={q ? "No matching customers" : "No customers yet"}>
            {q ? "Try a different name, phone number or pet name." : canWrite && <Link to="/customers/new">Add your first customer</Link>}
          </EmptyState>
        ) : list.data && (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Name</th><th scope="col">Pets</th><th scope="col">Phone</th><th scope="col">Email</th><th scope="col">Status</th></tr></thead>
                <tbody>
                  {list.data.items.map((c) => (
                    <tr key={c.id}>
                      <td><Link to={`/customers/${c.id}`}>{c.lastName}, {c.firstName}</Link></td>
                      <td>{c.petNames.join(", ") || <span className="muted">—</span>}</td>
                      <td>{c.phone ?? <span className="muted">—</span>}</td>
                      <td>{c.email ?? <span className="muted">—</span>}</td>
                      <td><StatusBadge status={c.status} archived={!!c.archivedAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>{list.data.total} customer{list.data.total === 1 ? "" : "s"}</span>
              <span className="actions">
                <button className="btn btn-small" disabled={page === 0} onClick={() => setParams({ ...(q && { q }), page: String(page - 1) })}>Previous</button>
                <button className="btn btn-small" disabled={(page + 1) * PAGE_SIZE >= list.data.total} onClick={() => setParams({ ...(q && { q }), page: String(page + 1) })}>Next</button>
              </span>
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
