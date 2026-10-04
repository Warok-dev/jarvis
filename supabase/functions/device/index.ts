// Point d'entrée du PC (app de bureau Tauri).
//   POST /device/register   — session utilisateur (une fois, après connexion dans la fenêtre)
//   POST /device/heartbeat  — signé HMAC : présence + commandes en attente
//   POST /device/result     — signé HMAC : avancement d'une commande
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { isFresh, parseSignedBody, signCommand, verify } from "../../../services/worker/src/devices/device-auth.ts";
import { b64urlDecode } from "../../../services/worker/src/push/webpush.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Secret ${name} manquant`);
  return v;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (body: unknown, status = 200) => Response.json(body, { status });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const route = new URL(req.url).pathname.split("/").pop();
  const db = createAdminClient(env("SUPABASE_URL"), env("JARVIS_SECRET_KEY"));
  const raw = await req.text();

  try {
    if (route === "register") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return json({ error: "Session invalide" }, 401);
      const body = JSON.parse(raw) as { device_id?: string; secret?: string; label?: string };
      if (!body.device_id || !UUID.test(body.device_id) || !body.secret || b64urlDecode(body.secret).length !== 32) {
        return json({ error: "Appareil invalide" }, 400);
      }
      // Un même PC (même identifiant) peut se réenregistrer, jamais pour le compte de quelqu'un d'autre.
      const { data: existing } = await db.from("devices").select("user_id").eq("id", body.device_id).maybeSingle();
      if (existing && existing.user_id !== user.id) return json({ error: "Appareil déjà associé" }, 409);
      const { error } = await db.from("devices").upsert({
        id: body.device_id, user_id: user.id, kind: "desktop",
        label: (body.label ?? "PC").slice(0, 60), secret: body.secret, last_seen_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    // Routes signées par le PC.
    const body = parseSignedBody(raw);
    const sig = req.headers.get("x-jarvis-signature") ?? "";
    if (!body || !UUID.test(body.device_id) || !isFresh(body.ts)) return json({ error: "Requête invalide ou expirée" }, 400);
    const { data: device } = await db.from("devices").select("id, user_id, secret").eq("id", body.device_id).maybeSingle();
    if (!device || !(await verify(device.secret, raw, sig))) return json({ error: "Signature invalide" }, 401);

    if (route === "heartbeat") {
      const now = new Date().toISOString();
      // Liste d'apps annoncée par le PC : seulement identifiant et nom, bornés.
      const apps = Array.isArray(body.apps)
        ? (body.apps as Array<{ id?: unknown; label?: unknown }>).slice(0, 50)
          .filter((a) => typeof a.id === "string" && typeof a.label === "string")
          .map((a) => ({ id: (a.id as string).slice(0, 40), label: (a.label as string).slice(0, 80) }))
        : [];
      await db.from("devices")
        .update({ last_seen_at: now, apps, remote_enabled: body.remote_enabled === true })
        .eq("id", device.id);
      // Commandes manquées (PC en veille au moment de l'envoi) : seulement celles encore valides.
      await db.from("pc_commands").update({ status: "expired", finished_at: now })
        .eq("device_id", device.id).eq("status", "pending").lt("expires_at", now);
      const { data: pending } = await db.from("pc_commands").select("id, steps, summary, expires_at")
        .eq("device_id", device.id).eq("status", "pending").gt("expires_at", now).order("created_at");
      const commands = await Promise.all((pending ?? []).map((c) => signCommand(device.secret, c)));
      return json({ ok: true, commands });
    }

    if (route === "result") {
      const status = body.status as string;
      if (!["running", "done", "failed", "rejected"].includes(status) || typeof body.command_id !== "string") {
        return json({ error: "Résultat invalide" }, 400);
      }
      const finished = status === "running" ? null : new Date().toISOString();
      const { error } = await db.from("pc_commands")
        .update({ status, result: String(body.result ?? "").slice(0, 500), finished_at: finished })
        .eq("id", body.command_id).eq("device_id", device.id).in("status", ["pending", "running"]);
      if (error) throw error;
      return json({ ok: true });
    }

    return json({ error: "Route inconnue" }, 404);
  } catch (err) {
    console.error("device", route, (err as Error).message);
    return json({ error: "Erreur serveur" }, 500);
  }
});
