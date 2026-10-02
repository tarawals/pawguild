import { useMutation, useQueryClient } from "@tanstack/react-query";
import { post, type InvoicePackages, type PackageLeft } from "../api";
import { formatDate } from "../units";
import { useCan } from "../auth";
import { ErrorAlert } from "./ui";

/**
 * Shows the prepaid package days on a stay's invoice and, while it's a draft, lets staff stop
 * using the package (the days are charged instead and go back on the package) or use it again.
 */
export function PackageToggle({ invoiceId, packages, reservationId }: { invoiceId: string; packages: InvoicePackages; reservationId?: string | null }) {
  const qc = useQueryClient();
  const canBill = useCan("billing:write");
  const change = useMutation({
    mutationFn: (use: boolean) => post(`/api/invoices/${invoiceId}/packages`, { use }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] }); qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["customer-packages"] });
      if (reservationId) { qc.invalidateQueries({ queryKey: ["checkout", reservationId] }); qc.invalidateQueries({ queryKey: ["reservation", reservationId] }); }
    },
  });
  if (packages.daysUsed === 0 && !packages.canChange) return null;
  const kind = (p: PackageLeft, n: number) => `${p.covers === "full_day" ? "full" : "half"} day${n === 1 ? "" : "s"}`;
  const left = (p: PackageLeft) => `${p.remaining} ${kind(p, p.remaining)} left${p.expiresOn ? `, use by ${formatDate(p.expiresOn)}` : ""}`;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <ErrorAlert error={change.error} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }} role="group" aria-label="Prepaid package">
        <span>
          {packages.daysUsed > 0
            ? <>Prepaid package: {packages.usedFrom.map((u, i) => (
                <span key={u.name}>{i > 0 && "; "}<strong>{u.days} day{u.days === 1 ? "" : "s"} from {u.name}</strong> — {left(u)}</span>
              ))}.</>
            : <>Package not used on this invoice. Available: {packages.available.map((p) => `${p.name} (${left(p)})`).join("; ")}.</>}
        </span>
        {packages.canChange && canBill && (
          <button className="btn btn-small" disabled={change.isPending} onClick={() => change.mutate(!packages.usePackages)}>
            {packages.usePackages ? "Don't use package" : "Use package"}
          </button>
        )}
      </div>
    </div>
  );
}
