import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CUSTOMER_STATUSES } from "@pawguild/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { get, patch, post, type Customer } from "../api";
import { Checkbox, ErrorAlert, fieldErrors, Loading, PageHeader, SelectField, TextArea, TextField } from "../components/ui";

const EMPTY = {
  firstName: "", lastName: "", email: "", phone: "", altPhone: "", addressLine1: "", addressLine2: "",
  city: "", region: "", postalCode: "", country: "", emergencyContactName: "", emergencyContactPhone: "",
  notes: "", status: "active", emailOptIn: true, smsOptIn: false,
};
type FormState = typeof EMPTY;

function fromCustomer(c: Customer): FormState {
  const out = { ...EMPTY };
  for (const key of Object.keys(EMPTY) as (keyof FormState)[]) {
    const v = c[key as keyof Customer];
    (out as Record<string, unknown>)[key] = v ?? (typeof EMPTY[key] === "boolean" ? false : "");
  }
  return out;
}

export function CustomerFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const existing = useQuery({ queryKey: ["customer", id], queryFn: () => get<Customer>(`/api/customers/${id}`), enabled: editing });

  useEffect(() => { if (existing.data) setForm(fromCustomer(existing.data)); }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const body = { ...form, country: form.country.toUpperCase() };
      return editing ? patch<Customer>(`/api/customers/${id}`, body) : post<Customer>("/api/customers", body);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer", c.id] });
      navigate(`/customers/${c.id}`);
    },
  });
  const err = fieldErrors(save.error);
  const text = (key: keyof FormState) => ({
    value: form[key] as string,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    error: err(key),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate();
  }

  if (editing && existing.isPending) return <Loading />;
  if (editing && existing.error) return <ErrorAlert error={existing.error} />;

  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/customers">Customers</Link>{editing && <> / <Link to={`/customers/${id}`}>{existing.data?.firstName} {existing.data?.lastName}</Link></>}</>}
        title={editing ? "Edit customer" : "New customer"}
      />
      <ErrorAlert error={save.error} />
      <form className="stack" onSubmit={onSubmit} noValidate>
        <fieldset>
          <legend>Contact</legend>
          <div className="form-grid">
            <TextField label="First name" required autoComplete="off" {...text("firstName")} />
            <TextField label="Last name" required autoComplete="off" {...text("lastName")} />
            <TextField label="Mobile phone" type="tel" {...text("phone")} />
            <TextField label="Alternate phone" type="tel" {...text("altPhone")} />
            <TextField label="Email" type="email" {...text("email")} />
            {editing && (
              <SelectField label="Account status" value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} error={err("status")}>
                {CUSTOMER_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
              </SelectField>
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend>Address</legend>
          <div className="form-grid">
            <TextField label="Street address" className="span-all" {...text("addressLine1")} />
            <TextField label="Apartment, suite, etc." className="span-all" {...text("addressLine2")} />
            <TextField label="City" {...text("city")} />
            <TextField label="State / region" {...text("region")} />
            <TextField label="Postal code" {...text("postalCode")} />
            <TextField label="Country" hint="Two-letter code, e.g. US" maxLength={2} {...text("country")} />
          </div>
        </fieldset>
        <fieldset>
          <legend>Emergency contact</legend>
          <div className="form-grid">
            <TextField label="Name" {...text("emergencyContactName")} />
            <TextField label="Phone" type="tel" {...text("emergencyContactPhone")} />
          </div>
        </fieldset>
        <fieldset>
          <legend>Preferences and notes</legend>
          <div className="stack">
            <Checkbox label="Email updates allowed" checked={form.emailOptIn} onChange={(e) => setForm((f) => ({ ...f, emailOptIn: e.target.checked }))} />
            <Checkbox label="Text messages allowed" checked={form.smsOptIn} onChange={(e) => setForm((f) => ({ ...f, smsOptIn: e.target.checked }))} />
            <TextArea label="Internal notes" hint="Visible to staff only." {...text("notes")} />
          </div>
        </fieldset>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Create customer"}</button>
          <Link className="btn" to={editing ? `/customers/${id}` : "/customers"}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
