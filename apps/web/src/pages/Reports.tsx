import { useQuery } from "@tanstack/react-query";
import { formatMoney, REFUND_METHOD_LABELS } from "@pawguild/shared";
import { Link, useSearchParams } from "react-router";
import { get, type BalancesReport, type OccupancyReport, type PaymentsReport, type SalesReport } from "../api";
import { EmptyState, ErrorAlert, Loading, PageHeader, Panel, TextField } from "../components/ui";
import { csvMoney, downloadCsv, type CsvCell } from "../csv";
import { formatDate } from "../units";

const TABS = [["sales", "Sales"], ["payments", "Payments"], ["balances", "Balances"], ["occupancy", "Occupancy"]] as const;
type Tab = (typeof TABS)[number][0];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function presets(now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  return [
    ["Today", iso(now), iso(now)],
    ["Last 7 days", iso(new Date(y, m, now.getDate() - 6)), iso(now)],
    ["This month", iso(new Date(y, m, 1)), iso(now)],
    ["Last month", iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
    ["Year to date", iso(new Date(y, 0, 1)), iso(now)],
  ] as const;
}
const methodLabel = (m: string) => (REFUND_METHOD_LABELS as Record<string, string>)[m] ?? m;
const right = { textAlign: "right" } as const;

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="panel stat"><div className="label">{label}</div><div className="value">{value}</div></div>;
}
function CsvButton({ filename, rows }: { filename: string; rows: () => CsvCell[][] }) {
  return <button className="btn btn-small" onClick={() => downloadCsv(filename, rows())}>Download CSV</button>;
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const month = presets()[2];
  const tab = (TABS.some(([t]) => t === params.get("tab")) ? params.get("tab") : "sales") as Tab;
  const from = params.get("from") ?? month[1];
  const to = params.get("to") ?? month[2];
  const set = (next: Record<string, string>) => setParams({ tab, from, to, ...next }, { replace: true });
  const rangeError = from && to && from > to ? "The start date must be on or before the end date" : undefined;

  return (
    <>
      <PageHeader title="Reports" description="Sales, money collected, what's owed and how full you've been. Dates use your organization's time zone." />
      <div className="actions" role="group" aria-label="Report" style={{ marginBottom: 16 }}>
        {TABS.map(([t, label]) => (
          <button key={t} className={`btn ${tab === t ? "btn-primary" : ""}`} aria-pressed={tab === t} onClick={() => set({ tab: t })}>{label}</button>
        ))}
      </div>
      {tab !== "balances" && (
        <div className="filters">
          <TextField label="From" type="date" value={from} max={to || undefined} onChange={(e) => e.target.value && set({ from: e.target.value })} />
          <TextField label="To" type="date" value={to} min={from || undefined} error={rangeError} onChange={(e) => e.target.value && set({ to: e.target.value })} />
          <div className="actions" role="group" aria-label="Date range presets">
            {presets().map(([label, f, t]) => (
              <button key={label} className={`btn btn-small ${from === f && to === t ? "btn-primary" : ""}`} aria-pressed={from === f && to === t}
                onClick={() => set({ from: f, to: t })}>{label}</button>
            ))}
          </div>
        </div>
      )}
      {!rangeError && tab === "sales" && <Sales from={from} to={to} />}
      {!rangeError && tab === "payments" && <Payments from={from} to={to} />}
      {tab === "balances" && <Balances />}
      {!rangeError && tab === "occupancy" && <OccupancyView from={from} to={to} />}
    </>
  );
}

function Sales({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ["reports", "sales", from, to], queryFn: () => get<SalesReport>(`/api/reports/sales?from=${from}&to=${to}`) });
  if (q.isPending) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const { totals, byService, byMonth } = q.data;
  const csv = () => [
    ["Service", "Category", "Quantity", "Gross", "Discounts", "Net (before tax)"],
    ...byService.map((s) => [s.service, s.category, s.quantity, csvMoney(s.grossCents), csvMoney(s.discountCents), csvMoney(s.netCents)]),
    ["Total", null, null, csvMoney(totals.grossCents), csvMoney(totals.discountCents), csvMoney(totals.netCents)],
    [],
    ["Tax", csvMoney(totals.taxCents)], ["Invoiced (incl. tax)", csvMoney(totals.invoicedCents)],
    ["Credit notes", csvMoney(totals.creditNotesCents)], ["Sales after credit notes", csvMoney(totals.salesAfterCreditsCents)],
  ];
  return (
    <div className="stack">
      <div className="stats" style={{ marginBottom: 0 }}>
        <Stat label="Invoices issued" value={totals.invoices} />
        <Stat label="Net sales (before tax)" value={formatMoney(totals.netCents)} />
        <Stat label="Tax collected" value={formatMoney(totals.taxCents)} />
        <Stat label="Credit notes" value={formatMoney(totals.creditNotesCents)} />
        <Stat label="Sales after credits" value={formatMoney(totals.salesAfterCreditsCents)} />
      </div>
      <Panel title="By service" actions={<CsvButton filename={`sales-${from}-to-${to}.csv`} rows={csv} />} bodyless>
        {byService.length === 0 ? <EmptyState title="No sales in this period">Only issued invoices count; drafts and void invoices are left out.</EmptyState> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Service</th><th scope="col" style={right}>Qty</th><th scope="col" style={right}>Gross</th>
                <th scope="col" style={right}>Discounts</th><th scope="col" style={right}>Net</th></tr></thead>
              <tbody>
                {byService.map((s) => (
                  <tr key={`${s.service}-${s.category}`}>
                    <td>{s.service}</td><td style={right}>{s.quantity}</td><td style={right}>{formatMoney(s.grossCents)}</td>
                    <td style={right}>{s.discountCents ? `−${formatMoney(s.discountCents)}` : "—"}</td><td style={right}>{formatMoney(s.netCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row">Total</th><td /><td style={right}>{formatMoney(totals.grossCents)}</td>
                  <td style={right}>{totals.discountCents ? `−${formatMoney(totals.discountCents)}` : "—"}</td><td style={right}><strong>{formatMoney(totals.netCents)}</strong></td></tr>
                <tr><th scope="row" colSpan={4}>Tax</th><td style={right}>{formatMoney(totals.taxCents)}</td></tr>
                <tr><th scope="row" colSpan={4}>Invoiced, including tax</th><td style={right}>{formatMoney(totals.invoicedCents)}</td></tr>
                <tr><th scope="row" colSpan={4}>Credit notes ({totals.creditNotes})</th><td style={right}>{totals.creditNotesCents ? `−${formatMoney(totals.creditNotesCents)}` : "—"}</td></tr>
                <tr><th scope="row" colSpan={4}>Sales after credit notes</th><td style={right}><strong>{formatMoney(totals.salesAfterCreditsCents)}</strong></td></tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
      {byMonth.length > 1 && (
        <Panel title="By month" bodyless>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Month</th><th scope="col" style={right}>Invoices</th><th scope="col" style={right}>Net</th>
                <th scope="col" style={right}>Tax</th><th scope="col" style={right}>Credit notes</th></tr></thead>
              <tbody>
                {byMonth.map((m) => (
                  <tr key={m.month}>
                    <td>{new Date(`${m.month}-15T12:00:00`).toLocaleDateString(undefined, { month: "long", year: "numeric" })}</td>
                    <td style={right}>{m.invoices}</td><td style={right}>{formatMoney(m.netCents)}</td><td style={right}>{formatMoney(m.taxCents)}</td>
                    <td style={right}>{m.creditNotesCents ? `−${formatMoney(m.creditNotesCents)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

function Payments({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ["reports", "payments", from, to], queryFn: () => get<PaymentsReport>(`/api/reports/payments?from=${from}&to=${to}`) });
  if (q.isPending) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const { totals, byMethod, payments, refunds, deposits } = q.data;
  const csv = () => [
    ["Type", "Method", "Count", "Amount"],
    ...payments.map((p) => ["Invoice payment", methodLabel(p.method), p.count, csvMoney(p.cents)]),
    ...deposits.map((p) => ["Deposit / prepayment", methodLabel(p.method), p.count, csvMoney(p.cents)]),
    ...refunds.map((p) => ["Refund", methodLabel(p.method), p.count, csvMoney(-p.cents)]),
    [],
    ["Net collected", null, null, csvMoney(totals.netCollectedCents)],
  ];
  const empty = payments.length + refunds.length + deposits.length === 0;
  return (
    <div className="stack">
      <div className="stats" style={{ marginBottom: 0 }}>
        <Stat label="Payments received" value={formatMoney(totals.paymentsCents)} />
        <Stat label="Deposits received" value={formatMoney(totals.depositsCents)} />
        <Stat label="Refunded" value={formatMoney(totals.refundsCents)} />
        <Stat label="Net collected" value={formatMoney(totals.netCollectedCents)} />
      </div>
      <Panel title="By payment method" actions={<CsvButton filename={`payments-${from}-to-${to}.csv`} rows={csv} />} bodyless>
        {empty ? <EmptyState title="No money moved in this period" /> : (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Method</th><th scope="col" style={right}>In</th><th scope="col" style={right}>Refunded</th><th scope="col" style={right}>Net</th></tr></thead>
                <tbody>
                  {byMethod.map((m) => (
                    <tr key={m.method}><td>{methodLabel(m.method)}</td><td style={right}>{formatMoney(m.inCents)}</td>
                      <td style={right}>{m.outCents ? `−${formatMoney(m.outCents)}` : "—"}</td><td style={right}>{formatMoney(m.netCents)}</td></tr>
                  ))}
                </tbody>
                <tfoot><tr><th scope="row" colSpan={3}>Net collected</th><td style={right}><strong>{formatMoney(totals.netCollectedCents)}</strong></td></tr></tfoot>
              </table>
            </div>
            <p className="muted panel-body" style={{ margin: 0 }}>
              In = invoice payments plus deposits taken. Account credit applied to invoices ({formatMoney(totals.creditAppliedCents)}) and
              overpayments moved to account credit ({formatMoney(totals.movedToCreditCents)}) are not new money and are left out.
              Voided payments are excluded.
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}

function Balances() {
  const q = useQuery({ queryKey: ["reports", "balances"], queryFn: () => get<BalancesReport>("/api/reports/balances") });
  if (q.isPending) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const { items, totals } = q.data;
  const csv = () => [
    ["Customer", "Owed", "Overpaid (owed back)", "Account credit", "Oldest unpaid invoice"],
    ...items.map((r) => [r.customerName, csvMoney(r.owedCents), csvMoney(r.overpaidCents), csvMoney(r.creditCents), r.oldestUnpaid?.slice(0, 10)]),
    ["Total", csvMoney(totals.owedCents), csvMoney(totals.overpaidCents), csvMoney(totals.creditCents), null],
  ];
  return (
    <div className="stack">
      <div className="stats" style={{ marginBottom: 0 }}>
        <Stat label="Owed by customers" value={formatMoney(totals.owedCents)} />
        <Stat label="Owed back (overpaid)" value={formatMoney(totals.overpaidCents)} />
        <Stat label="Account credit held" value={formatMoney(totals.creditCents)} />
      </div>
      <Panel title="Customer balances (as of now)" actions={<CsvButton filename={`balances-${new Date(q.data.asOf).toISOString().slice(0, 10)}.csv`} rows={csv} />} bodyless>
        {items.length === 0 ? <EmptyState title="Everyone is settled up" /> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Customer</th><th scope="col" style={right}>Owed</th><th scope="col" style={right}>Owed back</th>
                <th scope="col" style={right}>Account credit</th><th scope="col">Oldest unpaid</th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.customerId}>
                    <td><Link to={`/customers/${r.customerId}`}>{r.customerName}</Link></td>
                    <td style={right}>{r.owedCents ? formatMoney(r.owedCents) : "—"}</td>
                    <td style={right}>{r.overpaidCents ? formatMoney(r.overpaidCents) : "—"}</td>
                    <td style={right}>{r.creditCents ? formatMoney(r.creditCents) : "—"}</td>
                    <td>{r.oldestUnpaid ? formatDate(r.oldestUnpaid.slice(0, 10)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function OccupancyView({ from, to }: { from: string; to: string }) {
  const q = useQuery({ queryKey: ["reports", "occupancy", from, to], queryFn: () => get<OccupancyReport>(`/api/reports/occupancy?from=${from}&to=${to}`) });
  if (q.isPending) return <Loading />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  const pct = (s: { utilizationPercent: number | null }) => (s.utilizationPercent === null ? "No limit set" : `${s.utilizationPercent}%`);
  return (
    <div className="stack">
      {q.data.locations.map((l) => {
        const csv = () => [
          ["Date", "Daycare pets", "Daycare limit", "Boarding pets (nights)", "Boarding limit"],
          ...l.days.map((d) => [d.date, d.daycare, d.daycareLimit, d.boarding, d.boardingLimit]),
        ];
        return (
          <Panel key={l.locationId} title={l.locationName} actions={<CsvButton filename={`occupancy-${l.locationName}-${from}-to-${to}.csv`} rows={csv} />} bodyless>
            <div className="panel-body">
              <div className="stats">
                <Stat label="Daycare pet-days" value={l.daycare.petDays} />
                <Stat label="Daycare average / peak" value={`${l.daycare.averagePerDay} / ${l.daycare.peak}`} />
                <Stat label="Daycare utilization" value={pct(l.daycare)} />
              </div>
              <div className="stats" style={{ marginBottom: 0 }}>
                <Stat label="Boarding pet-nights" value={l.boarding.petDays} />
                <Stat label="Boarding average / peak" value={`${l.boarding.averagePerDay} / ${l.boarding.peak}`} />
                <Stat label="Boarding utilization" value={pct(l.boarding)} />
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Date</th><th scope="col" style={right}>Daycare</th><th scope="col" style={right}>Boarding (night of)</th></tr></thead>
                <tbody>
                  {l.days.map((d) => (
                    <tr key={d.date}>
                      <td>{formatDate(d.date)}</td>
                      <td style={right}>{d.daycare}{d.daycareLimit !== null && <span className="muted"> / {d.daycareLimit}</span>}</td>
                      <td style={right}>{d.boarding}{d.boardingLimit !== null && <span className="muted"> / {d.boardingLimit}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        );
      })}
      <p className="muted" style={{ margin: 0 }}>Counts pending, confirmed, checked-in and completed stays; cancellations and no-shows are left out. Limits are today's settings.</p>
    </div>
  );
}
