import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PET_SEXES, PET_STATUSES, SPECIES } from "@pawguild/shared";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, get, patch, post, type Customer, type Pet } from "../api";
import { Checkbox, ErrorAlert, fieldErrors, Loading, PageHeader, SelectField, TextArea, TextField } from "../components/ui";
import { gramsToLbs, lbsToGrams } from "../units";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EMPTY = {
  name: "", species: "dog", breed: "", sex: "unknown", isFixed: "", dateOfBirth: "", dateOfBirthIsEstimate: false,
  weightLbs: "", color: "", temperament: "", behaviorNotes: "", medicalNotes: "", allergies: "",
  feedingInstructions: "", specialInstructions: "", veterinarianName: "", veterinarianPhone: "", status: "active",
};
type FormState = typeof EMPTY;

function fromPet(p: Pet): FormState {
  return {
    name: p.name, species: p.species, breed: p.breed ?? "", sex: p.sex,
    isFixed: p.isFixed == null ? "" : String(p.isFixed), dateOfBirth: p.dateOfBirth ?? "",
    dateOfBirthIsEstimate: p.dateOfBirthIsEstimate, weightLbs: gramsToLbs(p.weightGrams), color: p.color ?? "",
    temperament: p.temperament ?? "", behaviorNotes: p.behaviorNotes ?? "", medicalNotes: p.medicalNotes ?? "",
    allergies: p.allergies ?? "", feedingInstructions: p.feedingInstructions ?? "",
    specialInstructions: p.specialInstructions ?? "", veterinarianName: p.veterinarianName ?? "",
    veterinarianPhone: p.veterinarianPhone ?? "", status: p.status,
  };
}

export function PetFormPage() {
  const { id, customerId: routeCustomerId } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY);
  const existing = useQuery({ queryKey: ["pet", id], queryFn: () => get<Pet>(`/api/pets/${id}`), enabled: editing });
  const customerId = routeCustomerId ?? existing.data?.customerId;
  const owner = useQuery({ queryKey: ["customer", customerId], queryFn: () => get<Customer>(`/api/customers/${customerId}`), enabled: Boolean(customerId) });

  useEffect(() => { if (existing.data) setForm(fromPet(existing.data)); }, [existing.data]);

  const save = useMutation({
    mutationFn: () => {
      const weightGrams = lbsToGrams(form.weightLbs);
      if (Number.isNaN(weightGrams)) {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "weightGrams", message: "Enter a weight in pounds, e.g. 42.5" }]);
      }
      const { weightLbs: _ignored, isFixed, dateOfBirth, ...rest } = form;
      const body = { ...rest, weightGrams, isFixed: isFixed === "" ? null : isFixed === "true", dateOfBirth: dateOfBirth || null };
      return editing ? patch<Pet>(`/api/pets/${id}`, body) : post<Pet>("/api/pets", { ...body, customerId });
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["pets"] });
      qc.invalidateQueries({ queryKey: ["pet", p.id] });
      qc.invalidateQueries({ queryKey: ["customer", p.customerId] });
      navigate(`/pets/${p.id}`);
    },
  });
  const err = fieldErrors(save.error);
  const text = (key: keyof FormState) => ({
    value: form[key] as string,
    onChange: (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value })),
    error: err(key === "weightLbs" ? "weightGrams" : key),
  });

  function onSubmit(e: FormEvent) { e.preventDefault(); save.mutate(); }

  if ((editing && existing.isPending) || owner.isPending) return <Loading />;
  if (existing.error || owner.error) return <ErrorAlert error={existing.error ?? owner.error} />;
  const ownerName = owner.data ? `${owner.data.firstName} ${owner.data.lastName}` : "";

  return (
    <>
      <PageHeader
        breadcrumb={<><Link to="/customers">Customers</Link> / <Link to={`/customers/${customerId}`}>{ownerName}</Link>{editing && <> / <Link to={`/pets/${id}`}>{existing.data?.name}</Link></>}</>}
        title={editing ? `Edit ${existing.data?.name}` : "Add pet"}
        description={!editing && `Owner: ${ownerName}`}
      />
      <ErrorAlert error={save.error} />
      <form className="stack" onSubmit={onSubmit} noValidate>
        <fieldset>
          <legend>Basics</legend>
          <div className="form-grid">
            <TextField label="Name" required {...text("name")} />
            <SelectField label="Species" {...text("species")}>
              {SPECIES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
            </SelectField>
            <TextField label="Breed" {...text("breed")} />
            <TextField label="Color / markings" {...text("color")} />
            <SelectField label="Sex" {...text("sex")}>
              {PET_SEXES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
            </SelectField>
            <SelectField label="Spayed / neutered" {...text("isFixed")}>
              <option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option>
            </SelectField>
            <TextField label="Date of birth" type="date" {...text("dateOfBirth")} />
            <TextField label="Weight (lb)" inputMode="decimal" {...text("weightLbs")} />
            <Checkbox label="Date of birth is approximate" checked={form.dateOfBirthIsEstimate} onChange={(e) => setForm((f) => ({ ...f, dateOfBirthIsEstimate: e.target.checked }))} />
            {editing && (
              <SelectField label="Status" {...text("status")}>
                {PET_STATUSES.map((s) => <option key={s} value={s}>{cap(s)}</option>)}
              </SelectField>
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend>Care</legend>
          <div className="form-grid">
            <TextArea label="Feeding instructions" {...text("feedingInstructions")} />
            <TextArea label="Allergies" {...text("allergies")} />
            <TextArea label="Medical notes" {...text("medicalNotes")} />
            <TextArea label="Special instructions" {...text("specialInstructions")} />
          </div>
        </fieldset>
        <fieldset>
          <legend>Behavior</legend>
          <div className="form-grid">
            <TextField label="Temperament" hint="e.g. Friendly, shy with large dogs" {...text("temperament")} />
            <TextArea label="Behavior notes" {...text("behaviorNotes")} />
          </div>
        </fieldset>
        <fieldset>
          <legend>Veterinarian</legend>
          <div className="form-grid">
            <TextField label="Clinic or vet name" {...text("veterinarianName")} />
            <TextField label="Phone" type="tel" {...text("veterinarianPhone")} />
          </div>
        </fieldset>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={save.isPending}>{save.isPending ? "Saving…" : editing ? "Save changes" : "Add pet"}</button>
          <Link className="btn" to={editing ? `/pets/${id}` : `/customers/${customerId}`}>Cancel</Link>
        </div>
      </form>
    </>
  );
}
