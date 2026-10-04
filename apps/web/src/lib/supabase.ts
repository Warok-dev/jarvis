import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) throw new Error("VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY manquants (apps/web/.env.local)");

// Clé publique : tout est filtré par RLS côté base.
export const supabase = createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true },
});
