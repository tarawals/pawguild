import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PASSWORD_MIN_LENGTH } from "@pawguild/shared";
import { useState, type FormEvent } from "react";
import { ApiError, post } from "../api";
import { useLogout, useMe } from "../auth";
import { ErrorAlert, fieldErrors, PageHeader, TextField } from "../components/ui";

export function ChangePasswordPage({ forced = false }: { forced?: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const logout = useLogout();
  const [f, setF] = useState({ current: "", next: "", confirm: "" });
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: () => {
      if (f.next !== f.confirm) {
        throw new ApiError(400, "validation_failed", "Some fields need attention.", [{ path: "confirm", message: "The new passwords don't match" }]);
      }
      return post("/api/auth/change-password", { currentPassword: f.current, newPassword: f.next });
    },
    onSuccess: () => { setDone(true); setF({ current: "", next: "", confirm: "" }); qc.invalidateQueries({ queryKey: ["me"] }); },
  });
  const err = fieldErrors(change.error);
  function onSubmit(e: FormEvent) { e.preventDefault(); setDone(false); change.mutate(); }

  const form = (
    <form className="stack" onSubmit={onSubmit} noValidate style={{ maxWidth: 420 }} aria-label="Change password">
      <ErrorAlert error={change.error && !err("currentPassword") && !err("newPassword") && !err("confirm") ? change.error : null} />
      {done && !forced && <div role="status" className="alert alert-warning" style={{ background: "var(--success-soft)", borderColor: "#b9dfc5", color: "var(--success)" }}>Password changed. Your other devices have been signed out.</div>}
      <TextField label={forced ? "Temporary password" : "Current password"} type="password" autoComplete="current-password"
        value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} error={err("currentPassword")} />
      <TextField label="New password" type="password" autoComplete="new-password" hint={`At least ${PASSWORD_MIN_LENGTH} characters.`}
        value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} error={err("newPassword")} />
      <TextField label="Confirm new password" type="password" autoComplete="new-password"
        value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} error={err("confirm")} />
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={change.isPending || !f.current || !f.next}>{forced ? "Set password and continue" : "Change password"}</button>
        {forced && <button className="btn" type="button" onClick={() => logout.mutate()}>Sign out</button>}
      </div>
    </form>
  );

  if (forced) {
    return (
      <main className="login-page">
        <div className="panel login-card">
          <div className="brand"><img src="/favicon.svg" alt="" /> PawGuild</div>
          <h1>Choose your password</h1>
          <p className="muted">Welcome, {me.user.firstName}. You signed in with a temporary password. Choose your own to continue.</p>
          {form}
        </div>
      </main>
    );
  }
  return (
    <>
      <PageHeader title="Change password" description={`Signed in as ${me.user.email}`} />
      {form}
    </>
  );
}
