import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { get } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, StatusBadge } from "../components/ui";

interface PetListItem { id: string; name: string; species: string; breed: string | null; status: string; archivedAt: string | null; customerId: string; customerName: string }

export function PetsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [draft, setDraft] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => { if (draft !== q) setParams(draft ? { q: draft } : {}, { replace: true }); }, 250);
    return () => clearTimeout(t);
  }, [draft, q, setParams]);

  const list = useQuery({
    queryKey: ["pets", q],
    queryFn: () => get<{ items: PetListItem[]; total: number }>(`/api/pets?${new URLSearchParams({ q, limit: "100" })}`),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title="Pets" description="To add a pet, open the owner's customer record." />
      <div className="field search" style={{ marginBottom: 16 }}>
        <label htmlFor="pet-search">Search pets</label>
        <input id="pet-search" type="search" placeholder="Pet name" value={draft} onChange={(e) => setDraft(e.target.value)} />
      </div>
      <ErrorAlert error={list.error} />
      <Panel bodyless>
        {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && list.data.items.length === 0 ? (
          <EmptyState title={q ? "No matching pets" : "No pets yet"} />
        ) : list.data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Species / breed</th><th scope="col">Owner</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {list.data.items.map((p) => (
                  <tr key={p.id}>
                    <td><Link to={`/pets/${p.id}`}>{p.name}</Link></td>
                    <td>{[p.species.charAt(0).toUpperCase() + p.species.slice(1), p.breed].filter(Boolean).join(" · ")}</td>
                    <td><Link to={`/customers/${p.customerId}`}>{p.customerName}</Link></td>
                    <td><StatusBadge status={p.status} archived={!!p.archivedAt} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.data.total > list.data.items.length && (
              <div className="pagination"><span>Showing {list.data.items.length} of {list.data.total}. Refine your search to narrow results.</span></div>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
