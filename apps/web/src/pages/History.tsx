import { useQuery } from "@tanstack/react-query";
import { get, type AuditEntry } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, Loading, Panel } from "../components/ui";
import { formatDateTime } from "../units";

function describe(entry: AuditEntry): string {
  const verb = entry.action.split(".")[1]?.replace(/_/g, " ") ?? entry.action;
  if (entry.changes && entry.action.endsWith(".updated")) {
    return `Updated ${Object.keys(entry.changes).map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")}`;
  }
  return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/** Change history for one record. Only shown to users with audit access. */
export function History({ entityType, entityId }: { entityType: string; entityId: string }) {
  const canRead = useCan("audit:read");
  const history = useQuery({
    queryKey: ["audit", entityType, entityId],
    queryFn: () => get<{ items: AuditEntry[] }>(`/api/audit?entityType=${entityType}&entityId=${entityId}&limit=25`),
    enabled: canRead,
  });
  if (!canRead) return null;
  return (
    <Panel title="History" bodyless>
      {history.isPending ? <div className="panel-body"><Loading /></div> : history.error ? <div className="panel-body"><ErrorAlert error={history.error} /></div> :
        history.data.items.length === 0 ? <EmptyState title="No history yet" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead>
              <tbody>
                {history.data.items.map((e) => (
                  <tr key={e.id}><td>{formatDateTime(e.createdAt)}</td><td>{e.actorName ?? "System"}</td><td>{describe(e)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </Panel>
  );
}
