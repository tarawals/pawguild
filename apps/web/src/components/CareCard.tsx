import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AMOUNT_EATEN_LABELS, AMOUNTS_EATEN, CARE_KIND_LABELS, MEALS, type CareKind } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { post, type CarePet, type CareStay, type Dose } from "../api";
import { useCan } from "../auth";
import { formatTime, timeAgo } from "../units";
import { IncidentForm } from "./IncidentForm";
import { ErrorAlert, fieldErrors, SelectField, TextField } from "./ui";

const QUICK: CareKind[] = ["potty", "walk", "play", "rest"];

function useLogCare(reservationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => post(`/api/reservations/${reservationId}/care-logs`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["care"] });
      qc.invalidateQueries({ queryKey: ["care-log", reservationId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });
}

function DoseRow({ dose, reservationId, petId }: { dose: Dose; reservationId: string; petId: string }) {
  const log = useLogCare(reservationId);
  const done = dose.status === "given" || dose.status === "refused" || dose.status === "skipped";
  const record = (status: string) => log.mutate({ kind: "medication", petId, medicationId: dose.medicationId, status, scheduledFor: dose.scheduledFor });
  return (
    <div className="dose">
      <span>
        <strong>{formatTime(dose.scheduledFor)}</strong> {dose.medicationName} <span className="muted">· {dose.dosage}</span>{" "}
        {dose.status === "overdue" && <span className="badge badge-danger">Overdue</span>}
        {done && <span className={`badge ${dose.status === "given" ? "badge-success" : "badge-warning"}`}>{dose.status[0]!.toUpperCase() + dose.status.slice(1)}</span>}
      </span>
      {!done && (
        <span className="actions">
          <button className="btn btn-small btn-primary" disabled={log.isPending} onClick={() => record("given")}
            aria-label={`Given: ${dose.medicationName} at ${formatTime(dose.scheduledFor)}`}>Given</button>
          <button className="btn btn-small" disabled={log.isPending} onClick={() => record("refused")}
            aria-label={`Refused: ${dose.medicationName} at ${formatTime(dose.scheduledFor)}`}>Refused</button>
        </span>
      )}
      {log.error && <div role="alert" style={{ color: "var(--danger)", fontSize: "0.85rem", width: "100%" }}>{log.error.message}</div>}
    </div>
  );
}

function FeedingForm({ reservationId, petId, onDone }: { reservationId: string; petId: string; onDone: () => void }) {
  const log = useLogCare(reservationId);
  const hour = new Date().getHours();
  const [meal, setMeal] = useState(hour < 11 ? "breakfast" : hour < 15 ? "lunch" : "dinner");
  const [amount, setAmount] = useState("all");
  const [notes, setNotes] = useState("");
  function onSubmit(e: FormEvent) { e.preventDefault(); log.mutate({ kind: "feeding", petId, meal, amountEaten: amount, notes }, { onSuccess: onDone }); }
  return (
    <form className="inline-form" onSubmit={onSubmit} aria-label="Record feeding">
      <SelectField label="Meal" value={meal} onChange={(e) => setMeal(e.target.value)}>
        {MEALS.map((m) => <option key={m} value={m}>{m[0]!.toUpperCase() + m.slice(1)}</option>)}
      </SelectField>
      <SelectField label="Amount eaten" value={amount} onChange={(e) => setAmount(e.target.value)}>
        {AMOUNTS_EATEN.map((a) => <option key={a} value={a}>{AMOUNT_EATEN_LABELS[a]}</option>)}
      </SelectField>
      <TextField label="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
      <button className="btn btn-primary" type="submit" disabled={log.isPending}>Save</button>
      <button className="btn" type="button" onClick={onDone}>Cancel</button>
      <ErrorAlert error={log.error} />
    </form>
  );
}

function NoteForm({ reservationId, petId, kind, onDone }: { reservationId: string; petId: string; kind: CareKind; onDone: () => void }) {
  const log = useLogCare(reservationId);
  const [notes, setNotes] = useState("");
  function onSubmit(e: FormEvent) { e.preventDefault(); log.mutate({ kind, petId, notes }, { onSuccess: onDone }); }
  return (
    <form className="inline-form" onSubmit={onSubmit} aria-label={`Record ${CARE_KIND_LABELS[kind].toLowerCase()}`}>
      <TextField label={kind === "note" ? "Note" : `${CARE_KIND_LABELS[kind]} notes (optional)`} autoFocus value={notes}
        onChange={(e) => setNotes(e.target.value)} error={fieldErrors(log.error)("notes")} />
      <button className="btn btn-primary" type="submit" disabled={log.isPending || (kind === "note" && !notes.trim())}>Save</button>
      <button className="btn" type="button" onClick={onDone}>Cancel</button>
      <ErrorAlert error={log.error} />
    </form>
  );
}

function PetCare({ stay, pet }: { stay: CareStay; pet: CarePet }) {
  const canCare = useCan("care:record");
  const canIncident = useCan("incidents:record");
  const log = useLogCare(stay.id);
  const [open, setOpen] = useState<"feeding" | "incident" | CareKind | null>(null);
  const asNeeded = pet.medications.filter((m) => m.times.length === 0);
  const flags = [
    pet.allergies && ["Allergies", pet.allergies],
    pet.medicalNotes && ["Medical", pet.medicalNotes],
    pet.specialInstructions && ["Special instructions", pet.specialInstructions],
  ].filter(Boolean) as [string, string][];
  const last = Object.entries(pet.lastCare).sort((a, b) => b[1].localeCompare(a[1]));

  return (
    <div className="care-pet">
      <h3>
        <Link to={`/pets/${pet.id}`}>{pet.name}</Link>
        {pet.kennel && <span className="badge">{pet.kennel}</span>}
        {pet.openIncidents > 0 && <Link to="/incidents" className="badge badge-danger">{pet.openIncidents} open incident{pet.openIncidents === 1 ? "" : "s"}</Link>}
      </h3>
      {flags.map(([t, v]) => <div key={t} className="care-flag"><strong>{t}</strong>{v}</div>)}
      {pet.feedingInstructions && <p style={{ margin: "8px 0" }}><strong>Feeding:</strong> {pet.feedingInstructions}</p>}
      {pet.doses.length > 0 && (
        <section aria-label={`${pet.name} medication today`}>
          {pet.doses.map((d) => <DoseRow key={`${d.medicationId}-${d.scheduledFor}`} dose={d} reservationId={stay.id} petId={pet.id} />)}
        </section>
      )}
      {canCare && asNeeded.map((m) => (
        <div className="dose" key={m.id}>
          <span>{m.name} <span className="muted">· {m.dosage} · as needed</span></span>
          <button className="btn btn-small" disabled={log.isPending} onClick={() => log.mutate({ kind: "medication", petId: pet.id, medicationId: m.id, status: "given" })}
            aria-label={`Give ${m.name} now`}>Give now</button>
        </div>
      ))}
      <p className="last-care" style={{ margin: "8px 0" }}>
        {last.length === 0 ? "Nothing logged yet this stay." : last.slice(0, 4).map(([k, at]) => `${CARE_KIND_LABELS[k as CareKind] ?? k} ${timeAgo(at)}`).join(" · ")}
      </p>
      {canCare && open === null && (
        <div className="quick-log" role="group" aria-label={`Log care for ${pet.name}`}>
          <button className="btn btn-small btn-primary" onClick={() => setOpen("feeding")}>Fed</button>
          {QUICK.map((k) => (
            <button key={k} className="btn btn-small" disabled={log.isPending} onClick={() => log.mutate({ kind: k, petId: pet.id })}
              aria-label={`${CARE_KIND_LABELS[k]}: ${pet.name}`}>{CARE_KIND_LABELS[k]}</button>
          ))}
          <button className="btn btn-small" onClick={() => setOpen("note")}>Note</button>
          {canIncident && <button className="btn btn-small btn-danger" onClick={() => setOpen("incident")}>Report incident</button>}
        </div>
      )}
      <ErrorAlert error={log.error} />
      {open === "feeding" && <FeedingForm reservationId={stay.id} petId={pet.id} onDone={() => setOpen(null)} />}
      {open === "note" && <NoteForm reservationId={stay.id} petId={pet.id} kind="note" onDone={() => setOpen(null)} />}
      {open === "incident" && <IncidentForm petId={pet.id} petName={pet.name} reservationId={stay.id} onDone={() => setOpen(null)} />}
    </div>
  );
}

export function CareCard({ stay }: { stay: CareStay }) {
  return (
    <section className="panel" aria-label={`${stay.pets.map((p) => p.name).join(", ")} care`}>
      <div className="panel-header">
        <div>
          <h2><Link to={`/reservations/${stay.id}`}>{stay.pets.map((p) => p.name).join(", ")}</Link></h2>
          <div className="muted" style={{ fontSize: "0.875rem" }}>
            {stay.serviceName} · {stay.customerName}{stay.customerPhone && ` · ${stay.customerPhone}`} · leaves {new Date(stay.endsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
          </div>
        </div>
      </div>
      <div className="panel-body">{stay.pets.map((p) => <PetCare key={p.id} stay={stay} pet={p} />)}</div>
    </section>
  );
}
