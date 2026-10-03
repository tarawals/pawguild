import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatMoney, PACKAGE_COVERS_LABELS, parseMoney, type PackageCovers } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError, get, patch, post } from "../api";
import { useCan } from "../auth";
import { formatDate, toLocalInput } from "../units";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, Panel, SelectField, TextField } from "./ui";

export interface MembershipPlan { id: string; name: string; covers: PackageCovers; daysPerMonth: number; priceCents: number; isTaxable: boolean; isActive: boolean }
export interface Membership {
  id: string; customerId: string; name: string; covers: PackageCovers; daysPerMonth: number; priceCents: number;
  startedOn: string; endsOn: string | null; cancelReason: string | null;
  status: "active" | "ending" | "ended" | "upcoming"; nextBillOn: string | null; due: boolean;
  current: { periodStart: string; periodEnd: string; remaining: number; days: number } | null;
  periods: { id: string; periodStart: string; periodEnd: string; invoiceId: string; invoiceStatus: string; remaining: number }[];
  customerName?: string;
}

const kind = (covers: PackageCovers, n: number) => `${covers === "full_day" ? "full" : "half"} day${n === 1 ? "" : "s"}`;
const STATUS: Record<Membership["status"], [string, string]> = {
  active: ["Active", "badge-success"], ending: ["Ending", "badge-warning"], ended: ["Ended", ""], upcoming: ["Starts soon", "badge-info"],
};
export const MembershipStatus = ({ m }: { m: Membership }) => <span className={`badge ${STATUS[m.status][1]}`}>{STATUS[m.status][0]}</span>;
export const monthLeft = (m: Membership) => m.current
  ? `${m.current.remaining} of ${m.daysPerMonth} ${kind(m.covers, m.daysPerMonth)} left this month (through ${formatDate(m.current.periodEnd)})`
  : m.status === "upcoming" ? `Starts ${formatDate(m.startedOn)}` : "No days this month";

function PlanForm({ plan, onDone }: { plan?: MembershipPlan; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    name: plan?.name ?? "", covers: plan?.covers ?? "full_day" as PackageCovers, days: String(plan?.daysPerMonth ?? 8),
    price: plan ? (plan.priceCents / 100).toFixed(2) : "", isTaxable: plan?.isTaxable ?? false, isActive: plan?.isActive ?? true,
  });
  const save = useMutation({
    mutationFn: () => {
      let priceCents: number;
      try { priceCents = parseMoney(f.price); } catch {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "priceCents", message: "Enter a price like 280 or 279.99" }]);
      }
      const body = { name: f.name, covers: f.covers, daysPerMonth: Number(f.days), priceCents, isTaxable: f.isTaxable, ...(plan && { isActive: f.isActive }) };
      return plan ? patch(`/api/membership-plans/${plan.id}`, body) : post("/api/membership-plans", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["membership-plans"] }); onDone(); },
  });
  const err = fieldErrors(save.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" aria-label={plan ? `Edit ${plan.name}` : "New membership plan"}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <TextField label="Plan name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} error={err("name")} placeholder="e.g. Full-Day Club" />
        <SelectField label="Covers" value={f.covers} onChange={(e) => setF({ ...f, covers: e.target.value as PackageCovers })}>
          {(Object.keys(PACKAGE_COVERS_LABELS) as PackageCovers[]).map((c) => <option key={c} value={c}>{PACKAGE_COVERS_LABELS[c]}</option>)}
        </SelectField>
        <TextField label="Days per month" inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} error={err("daysPerMonth")}
          hint="Unused days don't roll over." />
        <TextField label="Monthly price ($)" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} error={err("priceCents")} />
      </div>
      <Checkbox label="Charge sales tax on the membership" checked={f.isTaxable} onChange={(e) => setF({ ...f, isTaxable: e.target.checked })} />
      {plan && <Checkbox label="Open to new sign-ups" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />}
      {plan && <p className="muted" style={{ margin: 0 }}>Changes apply to new sign-ups. Current members keep their price and days.</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending}>{plan ? "Save plan" : "Add plan"}</button>
        <button className="btn" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** Business settings: membership plans. */
export function MembershipPlansPanel() {
  const canManage = useCan("settings:manage");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const list = useQuery({ queryKey: ["membership-plans", "all"], queryFn: () => get<{ items: MembershipPlan[] }>("/api/membership-plans?includeInactive=true") });
  return (
    <Panel title="Membership plans" bodyless actions={canManage && editing !== "new" && <button className="btn btn-small btn-primary" onClick={() => setEditing("new")}>Add plan</button>}>
      <p className="muted panel-body" style={{ margin: 0, paddingBottom: 0 }}>
        A monthly fee with included days of daycare. Billed on the sign-up date, then the same day each month, at full price. Unused days don't roll over;
        a cancelled membership runs to the end of the paid month.
      </p>
      {editing === "new" && <div className="panel-body"><PlanForm onDone={() => setEditing(null)} /></div>}
      {list.isPending ? <div className="panel-body"><Loading /></div> : list.data && (list.data.items.length === 0
        ? <EmptyState title="No membership plans yet">{canManage ? "Add one, like 8 full days a month for a set price." : "An owner or administrator can add them."}</EmptyState>
        : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Plan</th><th scope="col">Each month</th><th scope="col" style={{ textAlign: "right" }}>Price</th><th scope="col">Status</th>{canManage && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
              <tbody>
                {list.data.items.map((p) => editing === p.id ? (
                  <tr key={p.id}><td colSpan={5}><PlanForm plan={p} onDone={() => setEditing(null)} /></td></tr>
                ) : (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.daysPerMonth} {kind(p.covers, p.daysPerMonth)}</td>
                    <td style={{ textAlign: "right" }}>{formatMoney(p.priceCents)}/month{p.isTaxable && <span className="muted"> + tax</span>}</td>
                    <td>{p.isActive ? <span className="badge badge-success">Open</span> : <span className="badge">Closed to new members</span>}</td>
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

function MembershipItem({ m, canWrite, onChanged }: { m: Membership; canWrite: boolean; onChanged: (msg: string) => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => post<Membership>(`/api/memberships/${m.id}/cancel`, { reason }),
    onSuccess: (r) => { setCancelling(false); onChanged(r.endsOn ? `Cancelled. ${m.name} ends ${formatDate(r.endsOn)}, the last day of the paid month.` : "Cancelled."); },
  });
  const reinstate = useMutation({
    mutationFn: () => post<Membership>(`/api/memberships/${m.id}/reinstate`),
    onSuccess: () => onChanged(`${m.name} will continue.`),
  });
  return (
    <li className="dose" style={{ display: "block" }}>
      <ErrorAlert error={cancel.error ?? reinstate.error} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <strong>{m.name} · {formatMoney(m.priceCents)}/month</strong><MembershipStatus m={m} />
      </div>
      {m.status !== "ended" && <div>{monthLeft(m)}</div>}
      <div className="muted" style={{ fontSize: "0.875rem" }}>
        {m.status === "ending" && m.endsOn ? `Ends ${formatDate(m.endsOn)}${m.cancelReason ? ` (${m.cancelReason})` : ""}`
          : m.status === "ended" ? `Ended ${m.endsOn ? formatDate(m.endsOn) : ""}`
          : m.nextBillOn ? `Next bill ${formatDate(m.nextBillOn)}${m.due ? " — due now" : ""}` : ""}
        {m.periods.length > 0 && <> · <Link to={`/invoices/${m.periods[m.periods.length - 1]!.invoiceId}`}>Latest invoice</Link></>}
      </div>
      {canWrite && (m.status === "active" || m.status === "upcoming") && !cancelling && (
        <button className="btn btn-small btn-danger" style={{ marginTop: 6 }} onClick={() => setCancelling(true)}>Cancel membership</button>
      )}
      {canWrite && m.status === "ending" && (
        <button className="btn btn-small" style={{ marginTop: 6 }} disabled={reinstate.isPending} onClick={() => reinstate.mutate()}>Keep membership</button>
      )}
      {cancelling && (
        <form className="stack" style={{ gap: 6, marginTop: 6 }} aria-label={`Cancel ${m.name}`} onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <TextField label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)}
            hint={m.current ? `It stays active through ${formatDate(m.current.periodEnd)} (already paid) and won't bill again.` : "It won't be billed."} />
          <div className="actions">
            <button className="btn btn-danger btn-small" type="submit" disabled={cancel.isPending}>Cancel membership</button>
            <button className="btn btn-small" type="button" onClick={() => setCancelling(false)}>Keep it</button>
          </div>
        </form>
      )}
    </li>
  );
}

/** Customer page: memberships, this month's days, and signing up. */
export function CustomerMembershipsPanel({ customerId }: { customerId: string }) {
  const qc = useQueryClient();
  const canWrite = useCan("billing:write");
  const [planId, setPlanId] = useState("");
  const [startsOn, setStartsOn] = useState(() => toLocalInput(new Date()).slice(0, 10));
  const [message, setMessage] = useState<{ text: string; invoiceId?: string | null } | null>(null);
  const list = useQuery({ queryKey: ["customer-memberships", customerId], queryFn: () => get<{ items: Membership[] }>(`/api/customers/${customerId}/memberships`) });
  const plans = useQuery({ queryKey: ["membership-plans"], queryFn: () => get<{ items: MembershipPlan[] }>("/api/membership-plans"), enabled: canWrite });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["customer-memberships", customerId] }); qc.invalidateQueries({ queryKey: ["memberships"] }); qc.invalidateQueries({ queryKey: ["customer", customerId] }); };
  const signUp = useMutation({
    mutationFn: () => post<{ membership: Membership; invoiceId: string | null }>(`/api/customers/${customerId}/memberships`, { planId, startsOn }),
    onSuccess: (r) => {
      setPlanId("");
      setMessage({ text: r.invoiceId ? `Signed up for ${r.membership.name}. The first month is billed.` : `Signed up for ${r.membership.name}, starting ${formatDate(r.membership.startedOn)}.`, invoiceId: r.invoiceId });
      refresh(); qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
  const items = (list.data?.items ?? []).filter((m) => m.status !== "ended" || m.periods.length > 0);
  return (
    <Panel title="Memberships">
      <div className="stack" style={{ gap: 10 }}>
        <ErrorAlert error={list.error ?? signUp.error} />
        {message && <div role="status" className="alert alert-warning" style={{ marginBottom: 0 }}>
          {message.text} {message.invoiceId && <Link to={`/invoices/${message.invoiceId}`}>Take payment on the invoice</Link>}
        </div>}
        {list.isPending ? <Loading /> : items.length === 0 ? <p className="muted" style={{ margin: 0 }}>No memberships.</p> : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Customer memberships">
            {items.map((m) => <MembershipItem key={m.id} m={m} canWrite={canWrite} onChanged={(text) => { setMessage({ text }); refresh(); }} />)}
          </ul>
        )}
        {canWrite && (plans.data?.items.length ?? 0) > 0 && (
          <form onSubmit={(e) => { e.preventDefault(); setMessage(null); signUp.mutate(); }} noValidate className="inline-form" aria-label="Sign up for a membership" style={{ marginTop: 0 }}>
            <SelectField label="Membership plan" value={planId} onChange={(e) => setPlanId(e.target.value)} error={fieldErrors(signUp.error)("planId")}>
              <option value="">Choose…</option>
              {plans.data!.items.map((p) => <option key={p.id} value={p.id}>{p.name} — {formatMoney(p.priceCents)}/month ({p.daysPerMonth} {kind(p.covers, p.daysPerMonth)})</option>)}
            </SelectField>
            <TextField label="Starts (first bill)" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} error={fieldErrors(signUp.error)("startsOn")} />
            <button className="btn" type="submit" disabled={!planId || signUp.isPending}>Sign up</button>
          </form>
        )}
      </div>
    </Panel>
  );
}
