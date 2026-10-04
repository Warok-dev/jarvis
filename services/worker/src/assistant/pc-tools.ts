import type Anthropic from "@anthropic-ai/sdk";
import type { AdminClient } from "../db.ts";
import { broadcast, signCommand, topicFor, type PcStep } from "../devices/device-auth.ts";

// Outils « PC » de l'assistant. Ils passent par le client serveur (la file de commandes
// n'est pas modifiable avec la session de l'utilisateur), toujours restreints à son compte.
// Le PC revérifie tout de son côté : signature, expiration, liste blanche, interrupteur local.

export interface PcAccess {
  admin: AdminClient;
  userId: string;
  supabaseUrl: string;
  secretKey: string;
}

const ACTIONS = ["open_app", "open_url", "type_text", "press_key", "wait"] as const;
const WAIT_FOR_RESULT_MS = 20_000;

export const pcTools: Anthropic.Beta.BetaTool[] = [
  {
    name: "pc_status",
    description:
      "Indique si le PC de l'étudiant est allumé et joignable, si les commandes à distance y sont autorisées, " +
      "et la liste des applications que Jarvis peut y ouvrir (identifiant + nom). À appeler avant pc_run.",
    strict: true,
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "pc_run",
    description:
      "Exécute une courte suite d'actions sur le PC et attend le résultat. Actions : " +
      "open_app (app = identifiant renvoyé par pc_status), open_url (url https), " +
      "type_text (text ; seulement après open_app ou open_url dans la même suite), " +
      "press_key (key = enter, tab ou escape), wait (ms, pour laisser une app s'ouvrir, ex. 2500). " +
      "Les champs inutilisés d'une action valent null.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Description courte et lisible, affichée sur le PC (ex. « Ouvrir VS Code »)" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: [...ACTIONS] },
              app: { type: ["string", "null"] },
              url: { type: ["string", "null"] },
              text: { type: ["string", "null"] },
              key: { type: ["string", "null"], enum: ["enter", "tab", "escape", null] },
              ms: { type: ["integer", "null"] },
            },
            required: ["action", "app", "url", "text", "key", "ms"],
            additionalProperties: false,
          },
        },
      },
      required: ["summary", "steps"],
      additionalProperties: false,
    },
  },
];

export async function onlineDesktop(pc: PcAccess) {
  const { data, error } = await pc.admin
    .from("devices")
    .select("id, label, secret, apps, remote_enabled, last_seen_at")
    .eq("user_id", pc.userId)
    .eq("kind", "desktop")
    .gt("last_seen_at", new Date(Date.now() - 3 * 60_000).toISOString())
    .order("last_seen_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return data[0] ?? null;
}

// Ne garde que les champs utiles de chaque étape (le PC ignore le reste de toute façon).
function cleanSteps(raw: unknown): PcStep[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new Error("Suite d'actions vide ou trop longue.");
  return raw.map((s: Record<string, unknown>) => {
    const action = s.action as PcStep["action"];
    if (!(ACTIONS as readonly string[]).includes(action)) throw new Error(`Action inconnue : ${action}`);
    const step: PcStep = { action };
    for (const k of ["app", "url", "text", "key", "ms"]) if (s[k] !== null && s[k] !== undefined) step[k] = s[k];
    return step;
  });
}

export async function runPcTool(pc: PcAccess, name: string, input: Record<string, unknown>): Promise<string> {
  const desktop = await onlineDesktop(pc);

  if (name === "pc_status") {
    if (!desktop) return "Le PC est éteint ou hors ligne : impossible d'agir dessus pour l'instant.";
    return JSON.stringify({
      pc: desktop.label,
      en_ligne: true,
      commandes_autorisees: desktop.remote_enabled,
      apps: desktop.apps,
    });
  }

  if (name === "pc_run") {
    if (!desktop) return "Le PC est éteint ou hors ligne : la commande n'a pas été envoyée.";
    if (!desktop.remote_enabled) {
      return "Les commandes à distance sont désactivées sur le PC (menu de Jarvis dans la barre des tâches).";
    }
    const steps = cleanSteps(input.steps);
    const summary = String(input.summary ?? "Commande Jarvis").slice(0, 120);
    const { data: cmd, error } = await pc.admin
      .from("pc_commands")
      .insert({ user_id: pc.userId, device_id: desktop.id, steps, summary })
      .select("id, steps, summary, expires_at")
      .single();
    if (error) throw new Error(error.message);

    // Envoi immédiat par le canal temps réel ; à défaut, le prochain battement du PC la récupère.
    await broadcast(pc.supabaseUrl, pc.secretKey, await topicFor(desktop.secret), "command", { ...(await signCommand(desktop.secret, cmd)) });

    const deadline = Date.now() + WAIT_FOR_RESULT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const { data } = await pc.admin.from("pc_commands").select("status, result").eq("id", cmd.id).single();
      if (data && ["done", "failed", "rejected", "expired"].includes(data.status)) {
        return { done: "Fait.", failed: `Échec : ${data.result}`, rejected: `Refusé par le PC : ${data.result}`, expired: "Commande expirée." }[
          data.status as "done" | "failed" | "rejected" | "expired"
        ];
      }
    }
    return "Commande envoyée, mais pas de réponse du PC pour l'instant.";
  }

  throw new Error(`Outil inconnu : ${name}`);
}
