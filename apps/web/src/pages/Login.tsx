import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { post } from "../api";
import { ErrorAlert, TextField } from "../components/ui";

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const login = useMutation({
    mutationFn: () => post("/api/auth/login", { email, password }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from !== "/login" ? from : "/", { replace: true });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    login.mutate();
  }

  return (
    <main className="login-page">
      <div className="panel login-card">
        <div className="brand"><img src="/favicon.svg" alt="" /> PawGuild</div>
        <h1>Sign in</h1>
        <p className="muted">Staff access for your pet-care business.</p>
        <ErrorAlert error={login.error} />
        <form className="stack" onSubmit={onSubmit} noValidate>
          <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <TextField label="Password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary" type="submit" disabled={login.isPending || !email || !password}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
