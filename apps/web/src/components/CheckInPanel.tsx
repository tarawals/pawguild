import { VACCINE_STATE_LABELS } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { Reservation } from "../api";
import { useCan } from "../auth";
import { formatDate } from "../units";
import { useStatusChange } from "./StatusActions";
import { Checkbox, ErrorAlert, fieldErrors, Panel, TextArea } from "./ui";

const TONE = { current: "badge-success", missing: "badge-danger", expired: "badge-danger", expires_during_stay: "badge-warning" } as const;

/**
 * Check-in verification: vaccinations for every pet, kennel reminder, and the check-in action.
 * Shown before arrival (pending/confirmed) so staff can fix problems ahead of time.
 */
export function CheckInPanel({ reservation: r }: { reservation: Reservation }) {
  const canCheckIn = useCan("stays:check_in_out");
  const canOverride = useCan("stays:override_vaccinations");
  const change = useStatusChange(r.id);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");

  if (r.status !== "pending" && r.status !== "confirmed") return null;
  const blocked = r.vaccinationCheck.some((p) => !p.ok);
  const anyRequirements = r.vaccinationCheck.some((p) => p.checks.length > 0);
  const unassigned = r.service.category === "boarding" ? r.pets.filter((p) => !p.resourceId).map((p) => p.name) : [];
  const ready = r.status === "confirmed";

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    change.mutate(override ? { status: "checked_in", overrideVaccinations: true, overrideReason: reason } : { status: "checked_in" });
  }

  return (
    <Panel title={ready ? "Check-in" : "Before arrival"}>
      <div className="stack">
        {!anyRequirements ? (
          <p className="muted" style={{ margin: 0 }}>No vaccinations are required for {r.service.name}.</p>
        ) : r.vaccinationCheck.map((pet) => (
          <div key={pet.petId}>
            <h3 style={{ marginBottom: 6 }}>
              {pet.petName}{" "}
              {pet.ok ? <span className="badge badge-success">Vaccinations current</span> : <span className="badge badge-danger">Vaccinations needed</span>}
            </h3>
            {pet.checks.length > 0 && (
              <div className="table-wrap">
                <table>
                  <caption className="visually-hidden">Required vaccinations for {pet.petName}</caption>
                  <thead><tr><th scope="col">Vaccine</th><th scope="col">Status</th><th scope="col">Expires</th></tr></thead>
                  <tbody>
                    {pet.checks.map((c) => (
                      <tr key={c.vaccine}>
                        <td>{c.vaccine}</td>
                        <td><span className={`badge ${TONE[c.state]}`}>{VACCINE_STATE_LABELS[c.state]}</span></td>
                        <td>{formatDate(c.expiresOn)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!pet.ok && <p style={{ margin: "6px 0 0" }}><Link to={`/pets/${pet.petId}`}>Update {pet.petName}'s vaccinations</Link></p>}
          </div>
        ))}

        {unassigned.length > 0 && (
          <div className="alert alert-warning" style={{ margin: 0 }}>No kennel assigned for {unassigned.join(", ")}. Choose one in Kennels below.</div>
        )}

        {ready && canCheckIn && (
          <form onSubmit={onSubmit} noValidate className="stack" aria-label="Check in">
            <ErrorAlert error={change.error && !fieldErrors(change.error)("overrideReason") ? change.error : null} />
            {blocked && !canOverride && (
              <p style={{ margin: 0 }}>Check-in is blocked until the vaccinations above are current. A manager can override if needed.</p>
            )}
            {blocked && canOverride && (
              <div className="alert alert-warning stack" style={{ margin: 0 }}>
                <Checkbox label="Check in without current vaccinations (manager override)" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                {override && (
                  <TextArea label="Reason for override" hint="Recorded in the reservation history." value={reason}
                    onChange={(e) => setReason(e.target.value)} error={fieldErrors(change.error)("overrideReason")} />
                )}
              </div>
            )}
            <div>
              <button className="btn btn-primary" type="submit" disabled={change.isPending || (blocked && !override)}>
                {blocked && override ? "Check in with override" : "Check in"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Panel>
  );
}
