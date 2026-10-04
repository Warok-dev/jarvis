import { createClient } from "@supabase/supabase-js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant dans .env (voir .env.example)`);
  return v;
}

// Client « admin » du worker : la clé secrète contourne RLS, ne jamais l'utiliser dans les apps.
export function adminClient() {
  // Tolère une URL copiée avec /rest/v1/ : le client veut la racine du projet.
  const url = new URL(requireEnv("SUPABASE_URL")).origin;
  return createClient(url, requireEnv("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AdminClient = ReturnType<typeof adminClient>;
