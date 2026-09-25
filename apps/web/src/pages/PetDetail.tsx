import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { get, post, type Pet } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, StatusBadge, TextField } from "../components/ui";
import { daysUntil, formatDate, gramsToLbs } from "../units";
import { MedicationsPanel } from "../components/MedicationsPanel";
import { History } from "./History";

function age(dob: string | null, estimate: boolean): string {
  if (!dob) return "—";
  const [y, m] = dob.split("-").map(Number) as [number, number];
  const now = new Date();
  const months = (now.getFullYear() - y) * 12 + (now.getMonth() + 1 - m);
  const text = months < 24 ? `${months} months` : `${Math.floor(months / 12)} years`;
  return `${estimate ? "About " : ""}${text} (${formatDate(dob)})`;
}

function VaccinationForm({ petId }: { petId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ vaccine: "", administeredOn: "", expiresOn: "" });
  const add = useMutation({
    mutationFn: () => post(`/api/pets/${petId}/vaccinations`, { ...form, administeredOn: form.administeredOn || null }),
    onSuccess: () => {
      setForm({ vaccine: "", administeredOn: "", expiresOn: "" });
      qc.invalidateQueries({ queryKey: ["pet", petId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
      qc.invalidateQueries({ queryKey: ["reservation"] });
    },
  });
  const err = fieldErrors(add.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); add.mutate(); }
  return (
    <form onSubmit={onSubmit} noValidate className="stack" style={{ marginTop: 16 }} aria-label="Record vaccination">
      <ErrorAlert error={add.error} />
      <div className="form-grid">
        <TextField label="Vaccine" list="vaccine-names" value={form.vaccine} error={err("vaccine")} onChange={(e) => setForm({ ...form, vaccine: e.target.value })} />
        <datalist id="vaccine-names"><option value="Rabies" /><option value="DHPP" /><option value="Bordetella" /><option value="Canine Influenza" /><option value="Leptospirosis" /><option value="FVRCP" /></datalist>
        <TextField label="Given on" type="date" value={form.administeredOn} error={err("administeredOn")} onChange={(e) => setForm({ ...form, administeredOn: e.target.value })} />
        <TextField label="Expires on" type="date" value={form.expiresOn} error={err("expiresOn")} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
      </div>
      <div><button className="btn btn-primary btn-small" type="submit" disabled={add.isPending}>Record vaccination</button></div>
    </form>
  );
}

export function PetDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const canWrite = useCan("pets:write");
  const pet = useQuery({ queryKey: ["pet", id], queryFn: () => get<Pet>(`/api/pets/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pet", id] });
    qc.invalidateQueries({ queryKey: ["pets"] });
    qc.invalidateQueries({ queryKey: ["audit"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["reservation"] });
  };
  const archive = useMutation({ mutationFn: (action: "archive" | "restore") => post(`/api/pets/${id}/${action}`), onSuccess: refresh });
  const voidVax = useMutation({ mutationFn: (vid: string) => post(`/api/pets/${id}/vaccinations/${vid}/void`), onSuccess: refresh });

  if (pet.isPending) return <Loading />;
  if (pet.error) return <ErrorAlert error={pet.error} />;
  const p = pet.data;
  const archived = Boolean(p.archivedAt);
  const flags = [
    p.allergies && { title: "Allergies", text: p.allergies },
    p.medicalNotes && { title: "Medical", text: p.medicalNotes },
    p.specialInstructions && { title: "Special instructions", text: p.specialInstructions },
  ].filter(Boolean) as { title: string; text: string }[];

  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/customers">Customers</Link> / <Link to={`/customers/${p.owner?.id}`}>{p.owner?.firstName} {p.owner?.lastName}</Link></>}
        title={<>{p.name} <StatusBadge status={p.status} archived={archived} /></>}
        description={[p.species.charAt(0).toUpperCase() + p.species.slice(1), p.breed, p.color].filter(Boolean).join(" · ")}
        actions={canWrite && (
          <>
            {!archived && <Link className="btn" to={`/pets/${p.id}/edit`}>Edit</Link>}
            {archived ? <button className="btn" onClick={() => archive.mutate("restore")}>Restore</button> : (
              <button className="btn btn-danger" onClick={() => {
                if (window.confirm(`Archive ${p.name}? The pet will be hidden from lists. All records and history are kept.`)) archive.mutate("archive");
              }}>Archive</button>
            )}
          </>
        )}
      />
      <ErrorAlert error={archive.error ?? voidVax.error} />
      {archived && <div className="alert alert-warning">This pet is archived.</div>}
      <div className="grid-2">
        <div className="stack">
          {flags.length > 0 && (
            <section aria-label="Care alerts">{flags.map((f) => <div key={f.title} className="care-flag"><strong>{f.title}</strong>{f.text}</div>)}</section>
          )}
          <MedicationsPanel petId={p.id} archived={archived} />
          <Panel title="Vaccinations">
            {p.vaccinations && p.vaccinations.length > 0 ? (
              <div className="table-wrap">
                <table>
                  <thead><tr><th scope="col">Vaccine</th><th scope="col">Given</th><th scope="col">Expires</th>{canWrite && <th scope="col"><span className="visually-hidden">Actions</span></th>}</tr></thead>
                  <tbody>
                    {p.vaccinations.map((v) => {
                      const days = daysUntil(v.expiresOn);
                      return (
                        <tr key={v.id}>
                          <td>{v.vaccine}</td>
                          <td>{formatDate(v.administeredOn)}</td>
                          <td>{formatDate(v.expiresOn)} {days < 0 ? <span className="badge badge-danger">Expired</span> : days <= 30 ? <span className="badge badge-warning">Due soon</span> : null}</td>
                          {canWrite && <td><button className="btn btn-small" aria-label={`Void ${v.vaccine} record`} onClick={() => {
                            if (window.confirm(`Void this ${v.vaccine} record? Use this only for entries made in error. The record stays in history.`)) voidVax.mutate(v.id);
                          }}>Void</button></td>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : <EmptyState title="No vaccinations on file" />}
            {canWrite && !archived && <VaccinationForm petId={p.id} />}
          </Panel>
          <History entityType="pet" entityId={p.id} />
        </div>
        <div className="stack">
          <Panel title="Profile">
            <dl className="details">
              <dt>Sex</dt><dd>{p.sex.charAt(0).toUpperCase() + p.sex.slice(1)}{p.isFixed != null && ` · ${p.isFixed ? "Spayed/neutered" : "Intact"}`}</dd>
              <dt>Age</dt><dd>{age(p.dateOfBirth, p.dateOfBirthIsEstimate)}</dd>
              <dt>Weight</dt><dd>{p.weightGrams ? `${gramsToLbs(p.weightGrams)} lb` : "—"}</dd>
              <dt>Temperament</dt><dd>{p.temperament ?? "—"}</dd>
              <dt>Behavior</dt><dd>{p.behaviorNotes ?? "—"}</dd>
              <dt>Feeding</dt><dd>{p.feedingInstructions ?? "—"}</dd>
              <dt>Veterinarian</dt><dd>{[p.veterinarianName, p.veterinarianPhone].filter(Boolean).join(" · ") || "—"}</dd>
            </dl>
          </Panel>
          <Panel title="Owner">
            <dl className="details">
              <dt>Name</dt><dd><Link to={`/customers/${p.owner?.id}`}>{p.owner?.firstName} {p.owner?.lastName}</Link></dd>
              <dt>Phone</dt><dd>{p.owner?.phone ?? "—"}</dd>
              <dt>Email</dt><dd>{p.owner?.email ?? "—"}</dd>
              <dt>Emergency</dt><dd>{p.owner?.emergencyContactName ? `${p.owner.emergencyContactName}${p.owner.emergencyContactPhone ? ` · ${p.owner.emergencyContactPhone}` : ""}` : "—"}</dd>
            </dl>
          </Panel>
        </div>
      </div>
    </>
  );
}
