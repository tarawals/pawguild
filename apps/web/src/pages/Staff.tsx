import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { canAssignRole, ROLE_LABELS, ROLES, type Role } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { get, patch, post, type Employee, type Location } from "../api";
import { useCan, useMe } from "../auth";
import { Checkbox, EmptyState, ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextField } from "../components/ui";
import { formatDateTime } from "../units";

/** Readable temporary password, e.g. "kq7m-tz3p-hw9c" (no easily confused characters). */
function generatePassword(): string {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function useStaffUpdated() {
  const qc = useQueryClient();
  return () => { qc.invalidateQueries({ queryKey: ["employees"] }); qc.invalidateQueries({ queryKey: ["audit"] }); };
}

function RoleSelect({ value, onChange, actor, error }: { value: string; onChange: (v: string) => void; actor: Role; error?: string }) {
  return (
    <SelectField label="Role" value={value} onChange={(e) => onChange(e.target.value)} error={error}>
      {ROLES.filter((r) => canAssignRole(actor, r) || r === value).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
    </SelectField>
  );
}

function LocationPicker({ locations, value, onChange }: { locations: Location[]; value: string[]; onChange: (v: string[]) => void }) {
  if (locations.length <= 1 && value.length === 0 && locations[0]) {
    return <Checkbox label={`Works at ${locations[0].name}`} checked={false} onChange={(e) => onChange(e.target.checked ? [locations[0]!.id] : [])} />;
  }
  return (
    <fieldset>
      <legend>Locations</legend>
      <div className="pet-picker">
        {locations.map((l) => (
          <Checkbox key={l.id} label={l.name} checked={value.includes(l.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, l.id] : value.filter((x) => x !== l.id))} />
        ))}
      </div>
    </fieldset>
  );
}

function Credentials({ name, email, password, onDone }: { name: string; email: string; password: string; onDone: () => void }) {
  return (
    <div role="status" className="alert alert-warning stack" style={{ margin: 0 }}>
      <strong>Give these to {name} in person:</strong>
      <div>Email: <code>{email}</code></div>
      <div>Temporary password: <code style={{ fontSize: "1.1rem" }}>{password}</code></div>
      <span>They'll be asked to choose their own password when they sign in. This password won't be shown again.</span>
      <div><button className="btn btn-small" onClick={onDone}>Done</button></div>
    </div>
  );
}

function AddStaff({ locations, onDone }: { locations: Location[]; onDone: (creds: { name: string; email: string; password: string }) => void }) {
  const me = useMe();
  const updated = useStaffUpdated();
  const actor = me.role as Role;
  const assignable = ROLES.filter((r) => canAssignRole(actor, r));
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", phone: "", role: (assignable.includes("front_desk") ? "front_desk" : assignable[assignable.length - 1] ?? "employee") as string, jobTitle: "", locationIds: locations.length === 1 ? [locations[0]!.id] : [] as string[], password: generatePassword() });
  const create = useMutation({
    mutationFn: () => post<Employee>("/api/employees", {
      firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, role: f.role, jobTitle: f.jobTitle,
      locationIds: f.locationIds, temporaryPassword: f.password,
    }),
    onSuccess: (e) => { updated(); onDone({ name: e.firstName, email: e.email, password: f.password }); },
  });
  const err = fieldErrors(create.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); create.mutate(); }
  return (
    <form className="stack" noValidate onSubmit={onSubmit} aria-label="Add staff member">
      <ErrorAlert error={create.error} />
      <div className="form-grid">
        <TextField label="First name" value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} error={err("firstName")} />
        <TextField label="Last name" value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} error={err("lastName")} />
        <TextField label="Email" type="email" hint="They sign in with this." value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={err("email")} />
        <TextField label="Phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} actor={actor} error={err("role")} />
        <TextField label="Job title (optional)" value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} />
        <TextField label="Temporary password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} error={err("temporaryPassword")}
          hint="Generated for you. They must change it at first sign-in." />
      </div>
      {locations.length > 1 && <LocationPicker locations={locations} value={f.locationIds} onChange={(locationIds) => setF({ ...f, locationIds })} />}
      <div className="actions"><button className="btn btn-primary" type="submit" disabled={create.isPending}>Add staff member</button></div>
    </form>
  );
}

function EditStaff({ e, locations, onDone }: { e: Employee; locations: Location[]; onDone: () => void }) {
  const me = useMe();
  const updated = useStaffUpdated();
  const [f, setF] = useState({ role: e.role, jobTitle: e.jobTitle ?? "", phone: e.phone ?? "", locationIds: e.locationIds });
  const save = useMutation({
    mutationFn: () => patch(`/api/employees/${e.id}`, { ...(f.role !== e.role && { role: f.role }), jobTitle: f.jobTitle, phone: f.phone, locationIds: f.locationIds }),
    onSuccess: () => { updated(); onDone(); },
  });
  return (
    <form className="stack" noValidate onSubmit={(ev) => { ev.preventDefault(); save.mutate(); }} aria-label={`Edit ${e.firstName} ${e.lastName}`}>
      <ErrorAlert error={save.error} />
      <div className="form-grid">
        <RoleSelect value={f.role} onChange={(role) => setF({ ...f, role })} actor={me.role as Role} />
        <TextField label="Job title" value={f.jobTitle} onChange={(ev) => setF({ ...f, jobTitle: ev.target.value })} />
        <TextField label="Phone" type="tel" value={f.phone} onChange={(ev) => setF({ ...f, phone: ev.target.value })} />
      </div>
      {locations.length > 1 && <LocationPicker locations={locations} value={f.locationIds} onChange={(locationIds) => setF({ ...f, locationIds })} />}
      <div className="actions">
        <button className="btn btn-primary btn-small" type="submit" disabled={save.isPending}>Save</button>
        <button className="btn btn-small" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function StaffRow({ e, locations, onCredentials }: { e: Employee; locations: Location[]; onCredentials: (c: { name: string; email: string; password: string }) => void }) {
  const updated = useStaffUpdated();
  const [editing, setEditing] = useState(false);
  const toggle = useMutation({ mutationFn: () => post(`/api/employees/${e.id}/${e.isActive ? "deactivate" : "reactivate"}`), onSuccess: updated });
  const reset = useMutation({
    mutationFn: (password: string) => post(`/api/employees/${e.id}/reset-password`, { temporaryPassword: password }).then(() => password),
    onSuccess: (password) => { updated(); onCredentials({ name: e.firstName, email: e.email, password }); },
  });
  const name = `${e.firstName} ${e.lastName}`;
  const locationNames = e.locationIds.map((id) => locations.find((l) => l.id === id)?.name).filter(Boolean).join(", ");
  if (editing) return <tr><td colSpan={5}><EditStaff e={e} locations={locations} onDone={() => setEditing(false)} /></td></tr>;
  return (
    <tr style={e.isActive ? undefined : { opacity: 0.65 }}>
      <td><strong>{name}</strong><div className="muted">{e.email}{e.phone && ` · ${e.phone}`}</div></td>
      <td>{e.roleLabel}{e.jobTitle && <div className="muted">{e.jobTitle}</div>}{locationNames && <div className="muted">{locationNames}</div>}</td>
      <td>{e.lastLoginAt ? formatDateTime(e.lastLoginAt) : <span className="muted">Never</span>}</td>
      <td>
        {e.isActive ? <span className="badge badge-success">Active</span> : <span className="badge">Deactivated</span>}{" "}
        {e.isActive && e.mustChangePassword && <span className="badge badge-warning">Password not set yet</span>}
        <ErrorAlert error={toggle.error ?? reset.error} />
      </td>
      <td className="row-actions">
        {e.canManage && (
          <span className="actions" style={{ justifyContent: "flex-end" }}>
            {e.isActive && <button className="btn btn-small" onClick={() => setEditing(true)} aria-label={`Edit ${name}`}>Edit</button>}
            {e.isActive && <button className="btn btn-small" disabled={reset.isPending} aria-label={`Reset password for ${name}`} onClick={() => {
              if (window.confirm(`Reset ${name}'s password? They'll be signed out and must choose a new password.`)) reset.mutate(generatePassword());
            }}>Reset password</button>}
            <button className={`btn btn-small ${e.isActive ? "btn-danger" : ""}`} disabled={toggle.isPending} aria-label={`${e.isActive ? "Deactivate" : "Reactivate"} ${name}`} onClick={() => {
              if (!e.isActive || window.confirm(`Deactivate ${name}? They'll be signed out immediately and can't sign in until reactivated. Their history is kept.`)) toggle.mutate();
            }}>{e.isActive ? "Deactivate" : "Reactivate"}</button>
          </span>
        )}
      </td>
    </tr>
  );
}

export function StaffPage() {
  const canManage = useCan("employees:manage");
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState<{ name: string; email: string; password: string } | null>(null);
  const staff = useQuery({ queryKey: ["employees"], queryFn: () => get<{ items: Employee[] }>("/api/employees") });
  const locations = useQuery({ queryKey: ["locations"], queryFn: () => get<{ items: Location[] }>("/api/locations") });
  return (
    <>
      <PageHeader title="Staff" description="Who can sign in to PawGuild, and what they can do."
        actions={canManage && !adding && !creds && <button className="btn btn-primary" onClick={() => setAdding(true)}>Add staff member</button>} />
      {creds && <div style={{ marginBottom: 16 }}><Credentials {...creds} onDone={() => setCreds(null)} /></div>}
      {adding && locations.data && (
        <div style={{ marginBottom: 16 }}>
          <Panel title="Add staff member" actions={<button className="btn btn-small" onClick={() => setAdding(false)}>Cancel</button>}>
            <AddStaff locations={locations.data.items} onDone={(c) => { setAdding(false); setCreds(c); }} />
          </Panel>
        </div>
      )}
      <ErrorAlert error={staff.error} />
      <Panel bodyless>
        {staff.isPending ? <div className="panel-body"><Loading /></div> : staff.data && staff.data.items.length === 0 ? <EmptyState title="No staff yet" /> : staff.data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Last sign-in</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Actions</span></th></tr></thead>
              <tbody>{staff.data.items.map((e) => <StaffRow key={e.id} e={e} locations={locations.data?.items ?? []} onCredentials={setCreds} />)}</tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
