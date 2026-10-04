import { createClient } from "@supabase/supabase-js";

// Ce module tourne sous Node (scripts) et sous Deno (Edge Functions) :
// la lecture des variables d'environnement reste à l'appelant.

// Client « admin » du worker : la clé secrète contourne RLS, ne jamais l'utiliser dans les apps.
export function createAdminClient(supabaseUrl: string, secretKey: string) {
  // Tolère une URL copiée avec /rest/v1/ : le client veut la racine du projet.
  const url = new URL(supabaseUrl).origin;
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type AdminClient = ReturnType<typeof createAdminClient>;
