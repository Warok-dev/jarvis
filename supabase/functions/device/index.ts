// Point d'entrée du PC (app de bureau Tauri).
//   POST /device/register   — session du propriétaire (une fois, après connexion dans la fenêtre)
//   POST /device/heartbeat  — signé : présence + commandes en attente
//   POST /device/claim      — signé : réserve une commande avant de l'exécuter (atomique)
//   POST /device/result     — signé : issue d'une commande
//
// Signature : HMAC(secret, "<route>\n<corps brut>") ; horodatage frais et nonce à usage unique (anti-rejeu).
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { isFresh, parseSignedBody, signCommand, verify } from "../../../services/worker/src/devices/device-auth.ts";
import { b64urlDecode } from "../../../services/worker/src/push/webpush.ts";
import { isOwner, isUuid, readLimited } from "../../../services/worker/src/security.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Secret ${name} manquant`);
  return v;
}

const MAX_BODY = 16 * 1024;
const json = (body: unknown, status = 200) => Response.json(body, { status });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST attendu" }, 405);
  const route = new URL(req.url).pathname.split("/").pop() ?? "";
  const raw = await readLimited(req, MAX_BODY);
  if (raw === null) return json({ error: "Requête trop volumineuse" }, 413);

  try {
    const db = createAdminClient(env("SUPABASE_URL"), env("JARVIS_SECRET_KEY"));

    if (route === "register") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const { data: { user } } = await db.auth.getUser(token);
      if (!user) return json({ error: "Session invalide" }, 401);
      if (!isOwner(user.id, env("JARVIS_USER_ID"))) return json({ error: "Accès refusé" }, 403);

      let body: { device_id?: unknown; secret?: unknown; label?: unknown };
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: "Requête invalide" }, 400);
      }
      let secretOk = false;
      try {
        secretOk = typeof body.secret === "string" && b64urlDecode(body.secret).length === 32;
      } catch { /* base64 invalide */ }
      if (!isUuid(body.device_id) || !secretOk) return json({ error: "Appareil invalide" }, 400);
      const label = typeof body.label === "string" ? body.label.slice(0, 60) : "PC";

      // Un seul PC autorisé : un autre identifiant est refusé tant que l'ancien PC n'a pas été retiré.
      const { data: others } = await db.from("devices").select("id").eq("user_id", user.id).neq("id", body.device_id);
      if (others?.length) return json({ error: "Un autre PC est déjà associé" }, 409);

      const { error } = await db.from("devices").upsert({
        id: body.device_id, user_id: user.id, kind: "desktop", label,
        secret: body.secret as string, last_seen_at: new Date().toISOString(),
      });
      if (error) throw error;
      return json({ ok: true });
    }

    if (!["heartbeat", "claim", "result"].includes(route)) return json({ error: "Route inconnue" }, 404);

    // Routes signées par le PC.
    const body = parseSignedBody(raw);
    const sig = req.headers.get("x-jarvis-signature") ?? "";
    if (!body || !isUuid(body.device_id) || !isFresh(body.ts)) return json({ error: "Requête invalide ou expirée" }, 400);
    const { data: device } = await db.from("devices").select("id, user_id, secret").eq("id", body.device_id).maybeSingle();
    if (!device || !(await verify(device.secret, `${route}\n${raw}`, sig))) return json({ error: "Signature invalide" }, 401);
    // Anti-rejeu : chaque requête signée porte un nonce aléatoire qui ne sert qu'une fois.
    if (typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(body.nonce)) return json({ error: "Nonce manquant" }, 400);
    const { data: fresh } = await db.rpc("device_accept_nonce", { p_device: device.id, p_nonce: body.nonce });
    if (!fresh) return json({ error: "Requête déjà vue" }, 409);

    const now = new Date().toISOString();

    if (route === "heartbeat") {
      // Liste d'apps annoncée par le PC : seulement identifiant et nom, bornés.
      const apps = Array.isArray(body.apps)
        ? (body.apps as Array<{ id?: unknown; label?: unknown }>).slice(0, 50)
          .filter((a) => typeof a?.id === "string" && typeof a?.label === "string")
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

    if (!isUuid(body.command_id)) return json({ error: "Commande invalide" }, 400);

    if (route === "claim") {
      // Seule une commande en attente et non expirée peut être réservée, une seule fois.
      const { data, error } = await db.from("pc_commands").update({ status: "running" })
        .eq("id", body.command_id).eq("device_id", device.id).eq("status", "pending").gt("expires_at", now)
        .select("id");
      if (error) throw error;
      return json({ claimed: (data ?? []).length === 1 });
    }

    // route === "result"
    const status = body.status as string;
    const allowedFrom: Record<string, string[]> = {
      done: ["running"], failed: ["running"], rejected: ["pending", "running"],
    };
    if (!allowedFrom[status]) return json({ error: "Résultat invalide" }, 400);
    const { error } = await db.from("pc_commands")
      .update({ status, result: String(body.result ?? "").slice(0, 500), finished_at: now })
      .eq("id", body.command_id).eq("device_id", device.id).in("status", allowedFrom[status]);
    if (error) throw error;
    return json({ ok: true });
  } catch (err) {
    console.error("device", route, (err as Error).message);
    return json({ error: "Erreur serveur" }, 500);
  }
});
