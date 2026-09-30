import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { get, type AppNotification, type NotificationList } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel } from "../components/ui";

export const notificationsQuery = {
  queryKey: ["notifications"],
  queryFn: () => get<NotificationList>("/api/notifications"),
  // Problems are computed live; check again every minute.
  refetchInterval: 60_000,
} as const;

const GROUPS: [AppNotification["severity"], string, string][] = [
  ["high", "Needs action now", "badge-danger"],
  ["medium", "Needs attention soon", "badge-warning"],
  ["low", "When you can", "badge-info"],
];

export function NotificationsPage() {
  const q = useQuery(notificationsQuery);
  return (
    <>
      <PageHeader title="Notifications" description="Things that need someone's attention. Each one clears on its own once it's dealt with."
        actions={<button className="btn" onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? "Checking…" : "Check again"}</button>} />
      <ErrorAlert error={q.error} />
      {q.isPending ? <Loading /> : q.data && (q.data.total === 0
        ? <Panel><EmptyState title="Nothing needs attention">You'll see overdue medication, late pick-ups, open incidents and more here.</EmptyState></Panel>
        : (
          <div className="stack">
            {GROUPS.filter(([sev]) => q.data.counts[sev] > 0).map(([sev, label, badge]) => (
              <Panel key={sev} title={<>{label} <span className={`badge ${badge}`}>{q.data.counts[sev]}</span></>} bodyless>
                <ul style={{ listStyle: "none", margin: 0, padding: "4px 16px" }}>
                  {q.data.items.filter((i) => i.severity === sev).map((i) => (
                    <li key={i.id} className="dose" style={{ display: "block", padding: "10px 0" }}>
                      <Link to={i.link}><strong>{i.title}</strong></Link>
                      {i.detail && <div className="muted">{i.detail}</div>}
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
          </div>
        ))}
    </>
  );
}
