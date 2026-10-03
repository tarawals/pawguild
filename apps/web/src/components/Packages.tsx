import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney, PACKAGE_COVERS_LABELS, parseMoney, type PackageCovers } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, get, patch, post } from "../api";
import { useCan } from "../auth";
import { formatDate } from "../units";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, Panel, SelectField, TextField } from "./ui";

export interface PackageProduct {
  id: string; name: string; covers: PackageCovers; days: number; priceCents: number; expiresAfterDays: number | null; isTaxable: boolean; isActive: boolean;
}
interface CustomerPackage {
  id: string; name: string; covers: PackageCovers; days: number; used: number; remaining: number; priceCents: number;
  purchasedAt: string; expiresOn: string | null; invoiceId: string; status: "active" | "used_up" | "expired" | "void";
  uses: { usedOn: string; invoiceId: string; reservationId: string | null; invoiceStatus: string }[];
}

const EXPIRY_CHOICES: [string, string][] = [["", "Never expires"], ["30", "30 days"], ["60", "60 days"], ["90", "90 days"], ["180", "6 months (180 days)"], ["365", "1 year (365 days)"], ["custom", "Custom…"]];
export const expiryText = (days: number | null) => days === null ? "Never expires"
  : days % 365 === 0 ? `Expires ${days / 365} year${days === 365 ? "" : "s"} after purchase` : `Expires ${days} days after purchase`;
const dayWord = (covers: PackageCovers, n: number) => `${covers === "full_day" ? "full" : "half"} day${n === 1 ? "" : "s"}`;

function ProductForm({ product, onDone }: { product?: PackageProduct; onDone: () => void }) {
  const qc = useQueryClient();
  const preset = product?.expiresAfterDays == null ? "" : EXPIRY_CHOICES.some(([v]) => v === String(product.expiresAfterDays)) ? String(product.expiresAfterDays) : "custom";
  const [f, setF] = useState({
    name: product?.name ?? "", covers: product?.covers ?? "full_day" as PackageCovers, days: String(product?.days ?? 10),
    price: product ? (product.priceCents / 100).toFixed(2) : "", expiry: product ? preset : "365", customDays: product?.expiresAfterDays ? String(product.expiresAfterDays) : "",
    isTaxable: product?.isTaxable ?? false, isActive: product?.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      let priceCents: number;
      try { priceCents = parseMoney(f.price); } catch {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "priceCents", message: "Enter a price like 340 or 339.99" }]);
      }
      const expiresAfterDays = f.expiry === "" ? null : Number(f.expiry === "custom" ? f.customDays : f.expiry);
      const body = { name: f.name, covers: f.covers, days: Number(f.days), priceCents, expiresAfterDays, isTaxable: f.isTaxable, ...(product && { isActive: f.isActive }) };
      return product ? patch(`/api/package-products/${product.id}`, body) : post("/api/package-products", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["package-products"] }); onDone(); },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={product ? `Edit ${product.name}` : "New package"}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Package name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={err("name")} placeholder="e.g. 10 Full Days" />
        <SelectField label="Covers" value={f.covers} onChange={(e) => setF({ ...f, covers: e.target.value as PackageCovers })}>
          {(Object.keys(PACKAGE_COVERS_LABELS) as PackageCovers[]).map((c) => <option key={c} value={c}>{PACKAGE_COVERS_LABELS[c]}</option>)}
        </SelectField>
        <TextField label="Number of days" inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} error={err("days")} />
        <TextField label="Price ($)" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} error={err("priceCents")} />
        <SelectField label="Expires" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} error={f.expiry !== "custom" ? err("expiresAfterDays") : undefined}
          hint="Counted from the day it's sold. Days can't be used after that.">
          {EXPIRY_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </SelectField>
        {f.expiry === "custom" && (
          <TextField label="Expires after (days)" inputMode="numeric" value={f.customDays} onChange={(e) => setF({ ...f, customDays: e.target.value })} error={err("expiresAfterDays")} />
        )}
      </div>
      <Checkbox label="Charge sales tax on the package" checked={f.isTaxable} onChange={(e) => setF({ ...f, isTaxable: e.target.checked })} />
      {product && <Checkbox label="Available to sell" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />}
      {product && <p className="muted" style={{ margin: 0 }}>Changes apply to packages sold from now on. Packages already sold keep their days, price and expiry.</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{product ? "Save package" : "Add package"}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** Business settings: the packages the business sells. */
export function PackageProductsPanel() {
  const canManage = useCan("settings:manage");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = useQuery({ queryKey: ["package-products", "all"], queryFn: () => get<{ items: PackageProduct[] }>("/api/package-products?includeInactive=true") });
  return (
    <Panel title="Daycare packages" bodyless actions={canManage && editing !== "new" && <button className="btn btn-small btn-primary" onClick={() => setEditing("new")}>Add package</button>}>
      <p className="muted panel-body" style={{ margin: 0, paddingBottom: 0 }}>
        Prepaid days of daycare. When daycare is invoiced, full or half days are taken from the customer's package before anything is charged.
      </p>
      {list.error && <div className="panel-body"><ErrorAlert error={list.error} /></div>}
      {editing === "new" && <div className="panel-body"><ProductForm onDone={() => setEditing(null)} /></div>}
      {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && (list.data.items.length === 0
        ? <EmptyState title="No packages yet">{canManage ? "Add one, like 10 full days for a set price." : "An owner or administrator can add them."}</EmptyState>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Package</th><th scope="col">Covers</th><th scope="col" style={{ textAlign: "right" }}>Price</th><th scope="col">Expiry</th><th scope="col">Status</th>{canManage && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
              <tbody>
                {list.data.items.map((p) => editing === p.id ? (
                  <tr key={p.id}><td colSpan={6}><ProductForm product={p} onDone={() => setEditing(null)} /></td></tr>
                ) : (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.days} {dayWord(p.covers, p.days)}</td>
                    <td style={{ textAlign: "right" }}>{formatMoney(p.priceCents)}{p.isTaxable && <span className="muted"> + tax</span>}</td>
                    <td>{expiryText(p.expiresAfterDays)}</td>
                    <td>{p.isActive ? <span className="badge badge-success">For sale</span> : <span className="badge">Not sold</span>}</td>
                    {canManage && <td className="row-actions"><button className="btn btn-small" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p.id)}>Edit</button></td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </Panel>
  );
}

const STATUS: Record<CustomerPackage["status"], [string, string]> = {
  active: ["Active", "badge-success"], used_up: ["Used up", ""], expired: ["Expired", "badge-warning"], void: ["Void", "badge-muted"],
};

/** Customer page: their packages, days left, and selling a new one. */
export function CustomerPackagesPanel({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const canSell = useCan("billing:write");
  const [productId, setProductId] = useState("");
  const [sold, setSold] = useState<{ invoiceId: string; name: string } | null>(null);
  const list = useQuery({ queryKey: ["customer-packages", customerId], queryFn: () => get<{ items: CustomerPackage[] }>(`/api/customers/${customerId}/packages`) });
  const products = useQuery({ queryKey: ["package-products"], queryFn: () => get<{ items: PackageProduct[] }>("/api/package-products"), enabled: canSell });
  const sell = useMutation({
    mutationFn: () => post<{ invoiceId: string; package: CustomerPackage }>(`/api/customers/${customerId}/packages`, { productId }),
    onSuccess: (r) => {
      setSold({ invoiceId: r.invoiceId, name: r.package.name }); setProductId("");
      qc.invalidateQueries({ queryKey: ["customer-packages", customerId] }); qc.invalidateQueries({ queryKey: ["customer", customerId] }); qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
  const items = list.data?.items ?? [];
  const shown = items.filter((p) => p.status === "active" || p.remaining > 0 || p.used > 0);
  function onSubmit(e: FormEvent) { e.preventDefault(); setSold(null); sell.mutate(); }
  return (
    <Panel title="Packages">
      <div className="stack" style={{ gap: 10 }}>
        <ErrorAlert error={list.error ?? sell.error} />
        {sold && <div role="status" className="alert alert-warning" style={{ marginBottom: 0 }}>Sold {sold.name}. <Link to={`/invoices/${sold.invoiceId}`}>Take payment on the invoice</Link>.</div>}
        {list.isPending ? <Loading /> : shown.length === 0 ? <p className="muted" style={{ margin: 0 }}>No packages.</p> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Customer packages">
            {shown.map((p) => (
              <li key={p.id} className="dose" style={{ display: "block" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                  <strong>{p.name}</strong>
                  <span className={`badge ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span>
                </div>
                <div>{p.remaining} of {p.days} {dayWord(p.covers, p.days)} left</div>
                <div className="muted" style={{ fontSize: "0.875rem" }}>
                  {p.expiresOn ? `Use by ${formatDate(p.expiresOn)}` : "Never expires"} · <Link to={`/invoices/${p.invoiceId}`}>Sale invoice</Link>
                  {p.uses.filter((u) => u.invoiceStatus !== "void").length > 0 && ` · Used ${p.uses.filter((u) => u.invoiceStatus !== "void").map((u) => formatDate(u.usedOn)).join(", ")}`}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canSell && (products.data?.items.length ?? 0) > 0 && (
          <form onSubmit={onSubmit} noValidate className="inline-form" aria-label="Sell a package" style={{ marginTop: 0 }}>
            <SelectField label="Package to sell" value={productId} onChange={(e) => setProductId(e.target.value)} error={fieldErrors(sell.error)("productId")}>
              <option value="">Choose…</option>
              {products.data!.items.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.priceCents)} ({p.days} {dayWord(p.covers, p.days)}, {expiryText(p.expiresAfterDays).toLowerCase()})</option>)}
            </SelectField>
            <button className="btn" type="submit" disabled={!productId || sell.isPending}>Sell</button>
          </form>
        )}
      </div>
    </Panel>
  );
}
