import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { get, type DashboardSummary } from "../api";
import { useMe } from "../auth";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel } from "../components/ui";
import { daysUntil, formatDate } from "../units";

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
          <div className="stats">
            <div className="panel stat"><div className="label">Active customers</div><div className="value">{summary.data.activeCustomers}</div></div>
            <div className="panel stat"><div className="label">Active pets</div><div className="value">{summary.data.activePets}</div></div>
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
            Check-ins, occupancy, care tasks and balances will appear here as reservations, stays and billing are added.
          </p>
        </>
      )}
    </>
  );
}
