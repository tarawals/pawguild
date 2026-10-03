import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";
import { get, patch } from "../api";
import { BillingRulesPanel } from "../components/BillingRulesPanel";
import { MembershipPlansPanel } from "../components/Memberships";
import { PackageProductsPanel } from "../components/Packages";
import { useCan } from "../auth";
import { ErrorAlert, fieldErrors, Loading, PageHeader, Panel, SelectField, TextField } from "../components/ui";

interface OrgSettings {
  id: string; name: string; slug: string; email: string | null; phone: string | null; timezone: string; currency: string;
  locationsUsingThisTimezone: string[];
}

const TIME_ZONES: string[] = (() => {
  try { return Intl.supportedValuesOf("timeZone"); } catch { return ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"]; }
})();

export function SettingsPage() {
  const qc = useQueryClient();
  const canManage = useCan("settings:manage");
  const settings = useQuery({ queryKey: ["settings", "organization"], queryFn: () => get<OrgSettings>("/api/settings/organization") });
  const [form, setForm] = useState({ name: "", email: "", phone: "", timezone: "" });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setForm({ name: settings.data.name, email: settings.data.email ?? "", phone: settings.data.phone ?? "", timezone: settings.data.timezone });
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () => patch<OrgSettings>("/api/settings/organization", form),
    onSuccess: () => {
      setSaved(true);
      // The business name and time zone appear across the app; refresh everything.
      qc.invalidateQueries();
    },
  });
  const err = fieldErrors(save.error);
  if (settings.isPending) return <Loading />;
  if (!settings.data) return <ErrorAlert error={settings.error} />;
  const s = settings.data;
  const tzChanged = form.timezone !== s.timezone;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (tzChanged && !window.confirm(
      `Change the business time zone from ${s.timezone} to ${form.timezone}? ` +
      "This changes which calendar day counts as \"today\" for care, medication times, billing nights and days, reports and the dashboard" +
      (s.locationsUsingThisTimezone.length ? ` at ${s.locationsUsingThisTimezone.join(", ")}` : "") +
      ". Existing bookings keep their exact times.")) return;
    save.mutate();
  }

  return (
    <>
      <PageHeader title="Business settings" description="Your business's details, time zone, billing rules, daycare packages and memberships." />
      <Panel title="Business details">
        {!canManage ? (
          <dl className="details">
            <dt>Name</dt><dd>{s.name}</dd>
            <dt>Email</dt><dd>{s.email ?? "—"}</dd>
            <dt>Phone</dt><dd>{s.phone ?? "—"}</dd>
            <dt>Time zone</dt><dd>{s.timezone.replace(/_/g, " ")}</dd>
            <dt>Currency</dt><dd>{s.currency}</dd>
          </dl>
        ) : (
          <form onSubmit={onSubmit} noValidate className="stack" aria-label="Business details">
            <ErrorAlert error={save.error} />
            <div className="form-grid">
              <TextField label="Business name" required value={form.name} onChange={(e) => { setSaved(false); setForm({ ...form, name: e.target.value }); }} error={err("name")} />
              <TextField label="Email" type="email" value={form.email} onChange={(e) => { setSaved(false); setForm({ ...form, email: e.target.value }); }} error={err("email")} />
              <TextField label="Phone" type="tel" value={form.phone} onChange={(e) => { setSaved(false); setForm({ ...form, phone: e.target.value }); }} error={err("phone")} />
              <SelectField label="Time zone" value={form.timezone} onChange={(e) => { setSaved(false); setForm({ ...form, timezone: e.target.value }); }} error={err("timezone")}
                hint={s.locationsUsingThisTimezone.length
                  ? `Used by ${s.locationsUsingThisTimezone.join(", ")} (locations without their own time zone).`
                  : "Every location has its own time zone; this is used for business-wide dates."}>
                {!TIME_ZONES.includes(s.timezone) && <option value={s.timezone}>{s.timezone}</option>}
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>)}
              </SelectField>
            </div>
            {tzChanged && (
              <div className="alert alert-warning" style={{ marginBottom: 0 }}>
                Changing the time zone changes which day counts as "today" for care, billing, reports and the dashboard. You'll be asked to confirm.
              </div>
            )}
            <p className="muted" style={{ margin: 0 }}>Currency: {s.currency}. It can't be changed, because past invoices are recorded in it.</p>
            <div className="actions">
              <button className="btn btn-primary" type="submit" disabled={save.isPending}>Save settings</button>
              {saved && <span role="status" className="muted" style={{ alignSelf: "center" }}>Saved.</span>}
            </div>
          </form>
        )}
      </Panel>
      <div style={{ marginTop: 16 }}><BillingRulesPanel /></div>
      <div style={{ marginTop: 16 }}><PackageProductsPanel /></div>
      <div style={{ marginTop: 16 }}><MembershipPlansPanel /></div>
    </>
  );
}
