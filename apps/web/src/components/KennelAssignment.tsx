import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RESOURCE_KIND_LABELS, type ResourceKind } from "@pawguild/shared";
import { Fragment, useEffect, useState, type FormEvent } from "react";
import { get, put, type Reservation, type ResourceAvailability } from "../api";
import { useCan } from "../auth";
import { ErrorAlert, Panel } from "./ui";

/** Assign each pet on an active stay to a kennel/room, showing what's free for the stay's dates. */
export function KennelAssignment({ reservation }: { reservation: Reservation }) {
  const qc = useQueryClient();
  const canWrite = useCan("reservations:write");
  const canStay = useCan("stays:check_in_out");
  const canAssign = canWrite || canStay;
  const active = ["pending", "confirmed", "checked_in"].includes(reservation.status);
  const editable = canAssign && active;
  const [choice, setChoice] = useState<Record<string, string>>({});
  useEffect(() => {
    setChoice(Object.fromEntries(reservation.pets.map((p) => [p.id, p.resourceId ?? ""])));
  }, [reservation]);

  const availability = useQuery({
    queryKey: ["availability", reservation.location.id, reservation.startsAt, reservation.endsAt, reservation.id],
    queryFn: () => get<{ items: ResourceAvailability[] }>(`/api/resources/availability?${new URLSearchParams({
      locationId: reservation.location.id, startsAt: reservation.startsAt, endsAt: reservation.endsAt, excludeReservationId: reservation.id,
    })}`),
    enabled: editable,
  });
  const save = useMutation({
    mutationFn: () => put<Reservation>(`/api/reservations/${reservation.id}/assignments`, {
      assignments: reservation.pets.map((p) => ({ petId: p.id, resourceId: choice[p.id] || null })),
    }),
    onSuccess: (r) => {
      qc.setQueryData(["reservation", reservation.id], r);
      qc.invalidateQueries({ queryKey: ["availability"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
  const dirty = reservation.pets.some((p) => (p.resourceId ?? "") !== (choice[p.id] ?? ""));

  if (!editable) {
    if (reservation.pets.every((p) => !p.resourceId)) return null;
    return (
      <Panel title="Kennels">
        <dl className="details">{reservation.pets.map((p) => <Fragment key={p.id}><dt>{p.name}</dt><dd>{p.resourceName ?? "Not assigned"}</dd></Fragment>)}</dl>
      </Panel>
    );
  }
  const items = availability.data?.items ?? [];
  // Spaces this reservation's own pets would take in the current selection.
  const takenHere = (id: string) => Object.values(choice).filter((v) => v === id).length;

  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <Panel title="Kennels">
      {items.length === 0 && availability.isSuccess ? (
        <p className="muted" style={{ margin: 0 }}>No kennels or rooms are set up for {reservation.location.name}.</p>
      ) : (
        <form onSubmit={onSubmit} noValidate className="stack">
          <ErrorAlert error={save.error ?? availability.error} />
          <div className="form-grid">
            {reservation.pets.map((p) => (
              <div className="field" key={p.id}>
                <label htmlFor={`kennel-${p.id}`}>{p.name}</label>
                <select id={`kennel-${p.id}`} value={choice[p.id] ?? ""} onChange={(e) => setChoice({ ...choice, [p.id]: e.target.value })}>
                  <option value="">Not assigned</option>
                  {items.map((r) => {
                    const free = r.available - takenHere(r.id) + (choice[p.id] === r.id ? 1 : 0);
                    const full = free <= 0 && choice[p.id] !== r.id;
                    return (
                      <option key={r.id} value={r.id} disabled={full}>
                        {r.name} · {RESOURCE_KIND_LABELS[r.kind as ResourceKind] ?? r.kind} — {full ? "full" : r.capacity > 1 ? `${free} of ${r.capacity} free` : "free"}
                      </option>
                    );
                  })}
                </select>
              </div>
            ))}
          </div>
          <div><button className="btn btn-primary btn-small" type="submit" disabled={!dirty || save.isPending}>Save kennels</button></div>
        </form>
      )}
    </Panel>
  );
}
