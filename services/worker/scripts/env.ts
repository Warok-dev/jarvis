import { createAdminClient } from "../src/db.ts";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant dans .env (voir .env.example)`);
  return v;
}

export function adminClient() {
  return createAdminClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SECRET_KEY"));
}
