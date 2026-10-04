// Bouton « Tester » de l'app : envoie une notification aux appareils de l'utilisateur connecté.
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { sendPush } from "../../../services/worker/src/push/webpush.ts";

// tauri.localhost : app de bureau Windows.
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
    const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const { data: { user } } = await db.auth.getUser(token);
    if (!user) return json({ message: "Non connecté" }, 401);

    const { data: subs, error } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", user.id);
    if (error) throw error;
    if (!subs.length) return json({ message: "Aucun appareil abonné." });

    const vapid = { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY"), subject: env("VAPID_SUBJECT") };
    let ok = 0;
    for (const s of subs) {
      const r = await sendPush(s, { title: "Jarvis", body: "Les notifications fonctionnent.", url: "/", tag: "test" }, vapid, { ttlSeconds: 300, urgency: "high" });
      if (r.ok) ok++;
      else if (r.gone) await db.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("push-test refusé", r.status, r.body);
    }
    return json({ message: ok ? `Envoyée à ${ok} appareil(s).` : "L'envoi a échoué, réessaie après avoir réactivé les notifications." });
  } catch (err) {
    console.error("push-test", (err as Error).message);
    return json({ message: "Erreur serveur" }, 500);
  }
});
