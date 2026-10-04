import { useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message === "Invalid login credentials" ? "E-mail ou mot de passe incorrect." : error.message);
    setBusy(false);
  }

  return (
    <main className="login">
      <div className="login-mark" aria-hidden="true" />
      <h1>Jarvis</h1>
      <form onSubmit={submit}>
        <label>
          E-mail
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Mot de passe
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</button>
      </form>
    </main>
  );
}
