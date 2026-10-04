// Appelée toutes les 30 min par pg_cron (voir supabase/cron.sql.template).
// Le code de synchronisation est partagé avec les scripts Node du worker.
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { fetchFeed, parseFeed } from "../../../services/worker/src/brightspace/ical.ts";
import { syncBrightspace } from "../../../services/worker/src/brightspace/sync.ts";
import { safeEqual } from "../../../services/worker/src/security.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Secret ${name} manquant`);
  return v;
}

Deno.serve(async (req) => {
  // Déployée sans vérification JWT : seul pg_cron connaît ce secret.
  if (!(await safeEqual(req.headers.get("x-cron-secret") ?? "", env("CRON_SECRET")))) {
    return new Response("Non autorisé", { status: 401 });
  }
  try {
    const db = createAdminClient(env("SUPABASE_URL"), env("JARVIS_SECRET_KEY"));
    const events = parseFeed(await fetchFeed(env("BRIGHTSPACE_ICAL_URL")));
    const result = await syncBrightspace(db, env("JARVIS_USER_ID"), events);
    console.log("sync-brightspace", result);
    return Response.json(result);
  } catch (err) {
    console.error("sync-brightspace", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
});
