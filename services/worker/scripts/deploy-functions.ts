// Pousse les secrets depuis .env puis déploie les Edge Functions. Rien de secret n'est affiché.
// Usage : tsx scripts/deploy-functions.ts [nom…]   (par défaut : toutes)
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEnv } from "./env.ts";

const root = new URL("../../../", import.meta.url);
const ref = new URL(requireEnv("SUPABASE_URL")).host.split(".")[0];
const hide = (s: string) => s.split(ref).join("<ref>");

function supabase(args: string[]) {
  const r = spawnSync("npx", ["-y", "supabase", ...args, "--project-ref", ref], {
    cwd: root, encoding: "utf8", shell: true, env: process.env,
  });
  const out = hide(`${r.stdout}${r.stderr}`).trim().split("\n").slice(-4).join("\n");
  console.log(`supabase ${args.slice(0, 2).join(" ")} → ${r.status === 0 ? "ok" : `échec (${r.status})`}\n${out}`);
  if (r.status !== 0) process.exit(1);
}

// Clé publique de l'app (déjà livrée au navigateur) : sert à l'assistant pour agir avec la session de l'utilisateur.
const publishable = readFileSync(new URL("apps/web/.env.local", root), "utf8").match(/^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$/m)?.[1].trim();
if (!publishable) throw new Error("VITE_SUPABASE_PUBLISHABLE_KEY introuvable dans apps/web/.env.local");

const secrets: Record<string, string> = {
  JARVIS_SECRET_KEY: requireEnv("SUPABASE_SECRET_KEY"),
  JARVIS_USER_ID: requireEnv("SUPABASE_USER_ID"),
  BRIGHTSPACE_ICAL_URL: requireEnv("BRIGHTSPACE_ICAL_URL"),
  CRON_SECRET: requireEnv("CRON_SECRET"),
  VAPID_PUBLIC_KEY: requireEnv("VAPID_PUBLIC_KEY"),
  VAPID_PRIVATE_KEY: requireEnv("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: requireEnv("VAPID_SUBJECT"),
  JARVIS_PUBLISHABLE_KEY: publishable,
};
// Facultative tant que l'assistant n'est pas branché.
if (process.env.ANTHROPIC_API_KEY) secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Facultatif : horaire de cours uOttawa (flux iCal), importé chaque matin par la fonction plan.
if (process.env.TIMETABLE_ICAL_URL) secrets.TIMETABLE_ICAL_URL = process.env.TIMETABLE_ICAL_URL;
else console.log("ANTHROPIC_API_KEY absente de .env : l'assistant répondra qu'il n'est pas encore branché.");
const file = join(tmpdir(), `jarvis-secrets-${process.pid}.env`);
writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"));
try { supabase(["secrets", "set", "--env-file", file]); } finally { rmSync(file); }

const all = readdirSync(new URL("supabase/functions/", root), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : all) {
  supabase(["functions", "deploy", name, "--no-verify-jwt", "--use-api"]);
}
