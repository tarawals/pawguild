import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { RESERVATION_STATUS_LABELS, RESERVATION_STATUSES } from "@pawguild/shared";
import { Link, useSearchParams } from "react-router";
import { get, type ReservationListItem } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, ReservationStatusBadge } from "../components/ui";
import { formatRange } from "../units";

function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ReservationsPage() {
  const canWrite = useCan("reservations:write");
  const [params, setParams] = useSearchParams();
  const today = new Date();
  const from = params.get("from") ?? isoDay(today);
  const to = params.get("to") ?? isoDay(new Date(today.getTime() + 13 * 86400_000));
  const status = params.get("status") ?? "";
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  // Day boundaries in the browser's local time.
  const query = new URLSearchParams({
    from: new Date(`${from}T00:00`).toISOString(),
    to: new Date(new Date(`${to}T00:00`).getTime() + 86400_000).toISOString(),
    limit: "200",
    ...(status && { status }),
  });
  const list = useQuery({
    queryKey: ["reservations", from, to, status],
    queryFn: () => get<{ items: ReservationListItem[]; total: number }>(`/api/reservations?${query}`),
    placeholderData: keepPreviousData,
    enabled: Boolean(from && to),
  });

  return (
    <>
      <PageHeader
        title="Reservations"
        description="Daycare, boarding and grooming bookings."
        actions={canWrite && <Link className="btn btn-primary" to="/reservations/new">New reservation</Link>}
      />
      <div className="filters">
        <div className="field"><label htmlFor="res-from">From</label><input id="res-from" type="date" value={from} onChange={(e) => update("from", e.target.value)} /></div>
        <div className="field"><label htmlFor="res-to">To</label><input id="res-to" type="date" value={to} onChange={(e) => update("to", e.target.value)} /></div>
        <div className="field">
          <label htmlFor="res-status">Status</label>
          <select id="res-status" value={status} onChange={(e) => update("status", e.target.value)}>
            <option value="">All statuses</option>
            {RESERVATION_STATUSES.map((s) => <option key={s} value={s}>{RESERVATION_STATUS_LABELS[s]}</option>)}
          </select>
        </div>
      </div>
      <ErrorAlert error={list.error} />
      <Panel bodyless>
        {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && list.data.items.length === 0 ? (
          <EmptyState title="No reservations in this period">Change the dates or status filter{canWrite && <>, or <Link to="/reservations/new">create a reservation</Link></>}.</EmptyState>
        ) : list.data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">When</th><th scope="col">Pets</th><th scope="col">Customer</th><th scope="col">Service</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {list.data.items.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/reservations/${r.id}`}>{formatRange(r.startsAt, r.endsAt)}</Link></td>
                    <td>{r.petNames.join(", ")}</td>
                    <td><Link to={`/customers/${r.customerId}`}>{r.customerName}</Link></td>
                    <td>{r.serviceName}</td>
                    <td><ReservationStatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {list.data.total > list.data.items.length && <div className="pagination"><span>Showing {list.data.items.length} of {list.data.total}. Narrow the dates to see the rest.</span></div>}
          </div>
        )}
      </Panel>
    </>
  );
}
