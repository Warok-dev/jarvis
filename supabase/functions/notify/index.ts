// Appelée toutes les 5 min par pg_cron : nouveaux devoirs, échéances modifiées, rappels J-1 et H-3.
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { runNotify } from "../../../services/worker/src/notify/notify.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Secret ${name} manquant`);
  return v;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== env("CRON_SECRET")) {
    return new Response("Non autorisé", { status: 401 });
  }
  try {
    const db = createAdminClient(env("SUPABASE_URL"), env("JARVIS_SECRET_KEY"));
    const result = await runNotify(db, env("JARVIS_USER_ID"), {
      publicKey: env("VAPID_PUBLIC_KEY"),
      privateKey: env("VAPID_PRIVATE_KEY"),
      subject: env("VAPID_SUBJECT"),
    });
    if (result.created || result.pushes) console.log("notify", result);
    return Response.json(result);
  } catch (err) {
    console.error("notify", (err as Error).message);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
});
