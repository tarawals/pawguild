import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { formatMoney } from "@pawguild/shared";
import { get, type DashboardSummary, type ReservationListItem } from "../api";
import { useCan, useMe } from "../auth";
import { useStatusChange } from "../components/StatusActions";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, ReservationStatusBadge } from "../components/ui";
import { daysUntil, formatDate, formatTime } from "../units";

function QuickAction({ r, to, label }: { r: ReservationListItem; to: string; label: string }) {
  const change = useStatusChange(r.id);
  return (
    <>
      <button className="btn btn-small btn-primary" disabled={change.isPending} onClick={() => change.mutate({ status: to })}
        aria-label={`${label} ${r.petNames.join(", ")}`}>{label}</button>
      {change.error && <div role="alert" className="error" style={{ color: "var(--danger)", fontSize: "0.85rem" }}>{change.error.message}</div>}
    </>
  );
}

function StayTable({ rows, kind }: { rows: ReservationListItem[]; kind: "arrivals" | "departures" }) {
  const canStay = useCan("stays:check_in_out");
  const now = new Date();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th scope="col">{kind === "arrivals" ? "Drop-off" : "Pick-up"}</th><th scope="col">Pets</th><th scope="col">Customer</th><th scope="col">Service</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const time = kind === "arrivals" ? r.startsAt : r.endsAt;
            const overdue = kind === "departures" && new Date(r.endsAt) < now && new Date(r.endsAt).toDateString() !== now.toDateString();
            return (
              <tr key={r.id}>
                <td>{overdue ? <span className="badge badge-danger">Overdue · {new Date(r.endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span> : formatTime(time)}</td>
                <td><Link to={`/reservations/${r.id}`}>{r.petNames.join(", ")}</Link></td>
                <td>{r.customerName}</td>
                <td>{r.serviceName}</td>
                <td className="row-actions">
                  {kind === "arrivals" && r.status === "pending" && <ReservationStatusBadge status="pending" />}
                  {kind === "arrivals" && r.petsNeedingVaccinations && r.petsNeedingVaccinations.length > 0 ? (
                    <>
                      <span className="badge badge-danger">Vaccines needed</span>{" "}
                      <Link className="btn btn-small" to={`/reservations/${r.id}`} aria-label={`Review vaccinations for ${r.petNames.join(", ")}`}>Review</Link>
                    </>
                  ) : canStay && kind === "arrivals" && r.status === "confirmed" && <QuickAction r={r} to="checked_in" label="Check in" />}
                  {canStay && kind === "departures" && <QuickAction r={r} to="completed" label="Check out" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const me = useMe();
  const summary = useQuery({ queryKey: ["dashboard"], queryFn: () => get<DashboardSummary>("/api/dashboard/summary") });
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

  return (
    <>
      <PageHeader title={`Good day, ${me.user.firstName}`} description={today} />
      <ErrorAlert error={summary.error} />
      {summary.isPending ? <Loading /> : summary.data && (
        <>
          {summary.data.occupancy.map((o) => {
            const tile = (label: string, occ: { booked: number; limit: number | null }) => {
              const pct = occ.limit ? occ.booked / occ.limit : 0;
              const tone = occ.limit == null ? "" : pct >= 1 ? "badge-danger" : pct >= 0.85 ? "badge-warning" : "badge-success";
              return (
                <div className="panel stat">
                  <div className="label">{label}{summary.data!.occupancy.length > 1 && ` · ${o.locationName}`}</div>
                  <div className="value">{occ.booked}{occ.limit != null && <span className="muted" style={{ fontSize: "1rem", fontWeight: 500 }}> / {occ.limit}</span>}</div>
                  {occ.limit != null && <span className={`badge ${tone}`}>{occ.booked >= occ.limit ? "Full" : `${occ.limit - occ.booked} ${occ.limit - occ.booked === 1 ? "space" : "spaces"} left`}</span>}
                </div>
              );
            };
            return (
              <div key={o.locationId} className="stats">
                {tile("Daycare today", o.daycare)}
                {tile("Boarding tonight", o.boarding)}
              </div>
            );
          })}
          <div className="stats">
            <div className="panel stat"><div className="label">Arriving today</div><div className="value">{summary.data.arrivals.length}</div></div>
            <div className="panel stat"><div className="label">Pets checked in</div><div className="value">{summary.data.petsCheckedIn}</div></div>
            <div className="panel stat"><div className="label">Departing today</div><div className="value">{summary.data.departures.length}</div></div>
            {summary.data.outstanding ? (
              <Link to="/invoices?status=unpaid" className="panel stat" style={{ textDecoration: "none", color: "inherit" }}>
                <div className="label">Outstanding balances</div>
                <div className="value">{formatMoney(summary.data.outstanding.cents)}</div>
                <span className="muted" style={{ fontSize: "0.85rem" }}>{summary.data.outstanding.invoices} unpaid invoice{summary.data.outstanding.invoices === 1 ? "" : "s"}</span>
                {summary.data.outstanding.overpaidInvoices > 0 && <div><span className="badge badge-warning">{summary.data.outstanding.overpaidInvoices} overpaid — refund due</span></div>}
              </Link>
            ) : <div className="panel stat"><div className="label">Active customers</div><div className="value">{summary.data.activeCustomers}</div></div>}
          </div>
          <div className="stack" style={{ marginBottom: 16 }}>
            {(summary.data.medicationDue.length > 0 || summary.data.openIncidents.length > 0) && (
              <div className="grid-2">
                <Panel title="Medication due" bodyless actions={<Link className="btn btn-small" to="/care">Today's care</Link>}>
                  {summary.data.medicationDue.length === 0 ? <EmptyState title="Nothing due in the next 2 hours" /> : (
                    <ul style={{ listStyle: "none", margin: 0, padding: "4px 16px" }}>
                      {summary.data.medicationDue.map((d) => (
                        <li key={`${d.medicationId}-${d.scheduledFor}`} className="dose">
                          <span><strong>{formatTime(d.scheduledFor)}</strong> {d.petName} · {d.medicationName} <span className="muted">{d.dosage}</span></span>
                          {d.status === "overdue" ? <span className="badge badge-danger">Overdue</span> : <span className="badge badge-warning">Due</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
                <Panel title="Open incidents" bodyless actions={<Link className="btn btn-small" to="/incidents">All incidents</Link>}>
                  {summary.data.openIncidents.length === 0 ? <EmptyState title="No open incidents" /> : (
                    <ul style={{ listStyle: "none", margin: 0, padding: "4px 16px" }}>
                      {summary.data.openIncidents.map((i) => (
                        <li key={i.id} className="dose">
                          <span><Link to="/incidents">{i.petName}</Link> · {i.category}</span>
                          <span className={`badge severity-${i.severity}`}>{i.severity}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            )}
            <Panel title="Arrivals today" bodyless>
              {summary.data.arrivals.length === 0 ? <EmptyState title="No more arrivals today" /> : <StayTable rows={summary.data.arrivals} kind="arrivals" />}
            </Panel>
            <Panel title="Departures today" bodyless>
              {summary.data.departures.length === 0 ? <EmptyState title="No departures due" /> : <StayTable rows={summary.data.departures} kind="departures" />}
            </Panel>
          </div>
          <Panel title="Vaccinations needing attention" bodyless>
            {summary.data.vaccinationAlerts.length === 0 ? (
              <EmptyState title="All vaccinations are current">No active pet has a vaccination expiring in the next 30 days.</EmptyState>
            ) : (
              <div className="table-wrap">
                <table>
                  <caption className="visually-hidden">Vaccinations expired or expiring within 30 days</caption>
                  <thead><tr><th scope="col">Pet</th><th scope="col">Owner</th><th scope="col">Vaccine</th><th scope="col">Expires</th></tr></thead>
                  <tbody>
                    {summary.data.vaccinationAlerts.map((v) => {
                      const days = daysUntil(v.expiresOn);
                      return (
                        <tr key={`${v.petId}-${v.vaccine}`}>
                          <td><Link to={`/pets/${v.petId}`}>{v.petName}</Link></td>
                          <td>{v.customerName}</td>
                          <td>{v.vaccine}</td>
                          <td>
                            {formatDate(v.expiresOn)}{" "}
                            <span className={`badge ${days < 0 ? "badge-danger" : "badge-warning"}`}>
                              {days < 0 ? "Expired" : days === 0 ? "Today" : `${days} days`}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <p className="muted" style={{ marginTop: 16 }}>
            
          </p>
        </>
      )}
    </>
  );
}
