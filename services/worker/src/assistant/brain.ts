import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { chatClaude, type ChatTurn } from "./assistant.ts";
import { chatGemini } from "./gemini.ts";
import { onlineDesktop, runPcTool, type PcAccess } from "./pc-tools.ts";
import { joinFr, matchApp, matchAssignment, parseIntent, spokenDay, spokenTime, type Intent } from "./local-intents.ts";

// Aiguillage : d'abord l'interpréteur local (gratuit, instantané), sinon le modèle configuré.

export interface Providers {
  gemini?: { apiKey: string; model: string };
  claude?: Anthropic;
}

export type Answer = { reply: string; changed: boolean; via: "local" | "gemini" | "claude" | "none" };

const TZ = "America/Toronto";
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const hour = (d: Date) => hourFmt.format(d).replace(/\s*h\s*00$/, " h");
const DAY = 864e5;

function describe(a: { title: string; course_code: string | null }): string {
  return a.course_code ? `${a.title} en ${a.course_code}` : a.title;
}

async function upcoming(db: SupabaseClient, days: number, label: string, now: Date): Promise<string> {
  const { data, error } = await db.from("assignments").select("title, course_code, due_at")
    .is("removed_at", null).neq("status", "done")
    .gte("due_at", now.toISOString()).lte("due_at", new Date(now.getTime() + (days + 1) * DAY).toISOString())
    .order("due_at");
  if (error) throw new Error(error.message);
  const today = keyFmt.format(now);
  const target = keyFmt.format(new Date(now.getTime() + days * DAY));
  const items = (data ?? []).filter((a) => {
    const k = keyFmt.format(new Date(a.due_at));
    return days <= 1 ? k === target : k >= today && k <= target;
  });
  if (!items.length) return `Rien à rendre ${label}.`;
  const shown = items.slice(0, 6).map((a) => {
    const d = new Date(a.due_at);
    return days <= 1 ? `${describe(a)} ${spokenTime(d)}` : `${describe(a)}, ${spokenDay(d, now)} ${spokenTime(d)}`;
  });
  const more = items.length > 6 ? `, et ${items.length - 6} autre${items.length - 6 > 1 ? "s" : ""}` : "";
  const count = items.length === 1 ? "une chose" : `${items.length} choses`;
  const intro = label.charAt(0).toUpperCase() + label.slice(1);
  return `${intro}, tu as ${count} à rendre : ${joinFr(shown)}${more}.`;
}

async function plan(db: SupabaseClient, now: Date): Promise<string> {
  const { data, error } = await db.from("study_blocks").select("starts_at, ends_at, assignments(title, course_code, status)")
    .gte("ends_at", now.toISOString()).lte("starts_at", new Date(now.getTime() + 2 * DAY).toISOString()).order("starts_at");
  if (error) throw new Error(error.message);
  const blocks = (data ?? [])
    .map((b) => ({ ...b, a: b.assignments as unknown as { title: string; course_code: string | null; status: string } }))
    .filter((b) => b.a && b.a.status !== "done");
  if (!blocks.length) return "Rien de planifié pour aujourd'hui ni demain.";
  const firstDay = keyFmt.format(new Date(blocks[0].starts_at));
  // Blocs consécutifs du même devoir (séparés d'une simple pause) : annoncés en un seul créneau.
  const merged: Array<{ start: Date; end: Date; what: string }> = [];
  for (const b of blocks.filter((b) => keyFmt.format(new Date(b.starts_at)) === firstDay)) {
    const prev = merged[merged.length - 1];
    const start = new Date(b.starts_at);
    if (prev && prev.what === describe(b.a) && start.getTime() - prev.end.getTime() <= 30 * 60_000) {
      prev.end = new Date(b.ends_at);
    } else {
      merged.push({ start, end: new Date(b.ends_at), what: describe(b.a) });
    }
  }
  const sameDay = merged.slice(0, 4);
  const when = spokenDay(sameDay[0].start, now);
  const parts = sameDay.map((b) => `de ${hour(b.start)} à ${hour(b.end)}, ${b.what}`);
  return `${when.charAt(0).toUpperCase() + when.slice(1)} : ${joinFr(parts)}.`;
}

async function setStatus(db: SupabaseClient, status: "done" | "in_progress", query: string, device: string, now: Date) {
  const { data, error } = await db.from("assignments").select("id, title, course_code, status")
    .is("removed_at", null)
    .gte("due_at", new Date(now.getTime() - 14 * DAY).toISOString())
    .lte("due_at", new Date(now.getTime() + 60 * DAY).toISOString());
  if (error) throw new Error(error.message);
  const match = matchAssignment(query, data ?? []);
  if (!match) return null; // ambigu ou introuvable : le modèle demandera de préciser
  if (match.status === status) {
    return { reply: `${describe(match)} est déjà ${status === "done" ? "terminé" : "en cours"}.`, changed: false };
  }
  const { error: e } = await db.from("assignments").update({ status, status_changed_by: `voice-${device}` }).eq("id", match.id);
  if (e) throw new Error(e.message);
  return { reply: `C'est noté : ${describe(match)} est ${status === "done" ? "terminé. Bravo !" : "en cours."}`, changed: true };
}

async function openApp(pc: PcAccess | undefined, name: string): Promise<string> {
  if (!pc) return "Je ne peux pas agir sur le PC depuis ici.";
  const desktop = await onlineDesktop(pc);
  if (!desktop) return "Ton PC est éteint ou hors ligne, je ne peux pas ouvrir d'application.";
  if (!desktop.remote_enabled) return "Les commandes à distance sont désactivées sur ton PC. Active-les dans le menu de Jarvis.";
  const app = matchApp(name, (desktop.apps ?? []) as Array<{ id: string; label: string }>);
  if (!app) return `Je ne connais pas « ${name} » sur ton PC. Ajoute-la dans apps.json.`;
  const result = await runPcTool(pc, "pc_run", {
    summary: `Ouvrir ${app.label}`,
    steps: [{ action: "open_app", app: app.id, url: null, text: null, key: null, ms: null }],
  });
  return result === "Fait." ? `J'ouvre ${app.label}.` : result;
}

export async function runLocal(
  db: SupabaseClient, intent: Intent, device: string, pc?: PcAccess, now = new Date(),
): Promise<{ reply: string; changed: boolean } | null> {
  switch (intent.kind) {
    case "upcoming": return { reply: await upcoming(db, intent.days, intent.label, now), changed: false };
    case "plan": return { reply: await plan(db, now), changed: false };
    case "status": return setStatus(db, intent.status, intent.query, device, now);
    case "open_app": return { reply: await openApp(pc, intent.app), changed: false };
  }
}

export async function respond(
  db: SupabaseClient,
  history: ChatTurn[],
  device: "mobile" | "desktop" | "web",
  providers: Providers,
  pc?: PcAccess,
): Promise<Answer> {
  // Une phrase isolée et reconnue se traite localement (dans une conversation en cours, le
  // contexte compte : on laisse le modèle répondre s'il y en a un).
  const last = history[history.length - 1].content;
  const intent = parseIntent(last);
  const inConversation = history.length > 1 && (providers.gemini || providers.claude);
  if (intent && !inConversation) {
    const local = await runLocal(db, intent, device, pc);
    if (local) return { ...local, via: "local" };
  }
  if (providers.gemini) {
    return { ...(await chatGemini(providers.gemini.apiKey, providers.gemini.model, db, history, device, pc)), via: "gemini" };
  }
  if (providers.claude) {
    return { ...(await chatClaude(providers.claude, db, history, device, pc)), via: "claude" };
  }
  return {
    reply: "Je n'ai compris qu'une partie. Essaie par exemple : « Qu'est-ce que j'ai à rendre demain ? », « J'ai fini le lab 1 d'ELG » ou « Mon planning ».",
    changed: false,
    via: "none",
  };
}
