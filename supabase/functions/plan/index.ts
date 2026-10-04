// Planning de révision : recalcul à la demande (app, assistant) ou chaque matin (pg_cron).
// Le matin, importe aussi l'horaire de cours si TIMETABLE_ICAL_URL est configuré.
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { fetchFeed } from "../../../services/worker/src/brightspace/ical.ts";
import { runPlan, syncTimetable } from "../../../services/worker/src/planner/run.ts";

const ALLOWED_ORIGINS = ["https://jarvis-4s2.pages.dev", "http://tauri.localhost", "http://localhost:5180"];

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Secret ${name} manquant`);
  return v;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

  try {
    const db = createAdminClient(env("SUPABASE_URL"), env("JARVIS_SECRET_KEY"));
    let userId: string;
    let timetable = 0;
    if (req.headers.get("x-cron-secret") === env("CRON_SECRET")) {
      userId = env("JARVIS_USER_ID");
      const url = Deno.env.get("TIMETABLE_ICAL_URL");
      if (url) timetable = await syncTimetable(db, userId, await fetchFeed(url));
    } else {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return json({ error: "Non connecté" }, 401);
      userId = user.id;
    }
    const summary = await runPlan(db, userId);
    return json({ ...summary, timetable });
  } catch (err) {
    console.error("plan", (err as Error).message);
    return json({ error: "Erreur serveur" }, 500);
  }
});
