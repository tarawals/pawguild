import { useQuery } from "@tanstack/react-query";
import { formatMoney, PRICE_UNIT_LABELS, type PriceUnit } from "@pawguild/shared";
import { Link, useParams } from "react-router";
import { get, type Reservation } from "../api";
import { useCan } from "../auth";
import { CheckInPanel } from "../components/CheckInPanel";
import { KennelAssignment } from "../components/KennelAssignment";
import { StatusActions } from "../components/StatusActions";
import { ErrorAlert, Loading, PageHeader, Panel, ReservationStatusBadge } from "../components/ui";
import { formatDateTime, formatRange } from "../units";
import { History } from "./History";

export function ReservationDetailPage() {
  const { id } = useParams();
  const canWrite = useCan("reservations:write");
  const res = useQuery({ queryKey: ["reservation", id], queryFn: () => get<Reservation>(`/api/reservations/${id}`) });
  if (res.isPending) return <Loading />;
  if (res.error) return <ErrorAlert error={res.error} />;
  const r = res.data;
  const editable = r.status === "pending" || r.status === "confirmed";
  const alerts = r.pets.flatMap((p) => [
    p.allergies && { key: `${p.id}-a`, title: `${p.name}: allergies`, text: p.allergies },
    p.medicalNotes && { key: `${p.id}-m`, title: `${p.name}: medical`, text: p.medicalNotes },
  ]).filter(Boolean) as { key: string; title: string; text: string }[];

  return (
    <>
      <PageHeader
        breadcrumb={<Link to="/reservations">Reservations</Link>}
        title={<>{r.pets.map((p) => p.name).join(", ")} · {r.service.name} <ReservationStatusBadge status={r.status} /></>}
        description={formatRange(r.startsAt, r.endsAt)}
        actions={canWrite && editable && <Link className="btn" to={`/reservations/${r.id}/edit`}>Edit</Link>}
      />
      <div style={{ marginBottom: 16 }}><StatusActions reservation={r} exclude={["checked_in"]} /></div>
      <div className="grid-2">
        <div className="stack">
          {alerts.length > 0 && <section aria-label="Care alerts">{alerts.map((a) => <div key={a.key} className="care-flag"><strong>{a.title}</strong>{a.text}</div>)}</section>}
          <CheckInPanel reservation={r} />
          <KennelAssignment reservation={r} />
          <Panel title="Pets" bodyless>
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Pet</th><th scope="col">Breed</th></tr></thead>
                <tbody>{r.pets.map((p) => <tr key={p.id}><td><Link to={`/pets/${p.id}`}>{p.name}</Link></td><td>{p.breed ?? "—"}</td></tr>)}</tbody>
              </table>
            </div>
          </Panel>
          {r.notes && <Panel title="Notes"><p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.notes}</p></Panel>}
          <History entityType="reservation" entityId={r.id} />
        </div>
        <div className="stack">
          <Panel title="Details">
            <dl className="details">
              <dt>Customer</dt><dd><Link to={`/customers/${r.customer.id}`}>{r.customer.firstName} {r.customer.lastName}</Link>{r.customer.phone && ` · ${r.customer.phone}`}</dd>
              <dt>Service</dt><dd>{r.service.name}</dd>
              <dt>Location</dt><dd>{r.location.name}</dd>
              <dt>Booked</dt><dd>{formatDateTime(r.createdAt)}</dd>
              {r.confirmedAt && <><dt>Confirmed</dt><dd>{formatDateTime(r.confirmedAt)}</dd></>}
              {r.checkedInAt && <><dt>Checked in</dt><dd>{formatDateTime(r.checkedInAt)}</dd></>}
              {r.checkedOutAt && <><dt>Checked out</dt><dd>{formatDateTime(r.checkedOutAt)}</dd></>}
              {r.cancelledAt && <><dt>Cancelled</dt><dd>{formatDateTime(r.cancelledAt)}{r.cancellationReason && ` — ${r.cancellationReason}`}</dd></>}
            </dl>
          </Panel>
          <Panel title="Estimated charges">
            <dl className="details">
              <dt>Rate</dt><dd>{formatMoney(r.unitPriceCents)} {PRICE_UNIT_LABELS[r.priceUnit as PriceUnit]}</dd>
              <dt>Quantity</dt><dd>{r.estimate.quantity} × {r.estimate.petCount} pet{r.estimate.petCount === 1 ? "" : "s"}</dd>
              <dt>Estimate</dt><dd><strong>{formatMoney(r.estimate.totalCents)}</strong></dd>
            </dl>
            <p className="muted" style={{ margin: "12px 0 0", fontSize: "0.875rem" }}>Before tax, discounts and add-ons. The rate is locked at the price when booked.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
