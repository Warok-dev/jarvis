// Pousse les secrets depuis .env puis déploie les Edge Functions. Rien de secret n'est affiché.
// Usage : tsx scripts/deploy-functions.ts [nom…]   (par défaut : toutes)
//
// Sécurité : CLI Supabase épinglée (devDependency, appelée sans shell), environnement minimal
// pour le processus enfant (seul le jeton de gestion lui est transmis), fichier de secrets
// temporaire privé et supprimé dans tous les cas.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireEnv } from "./env.ts";

const root = new URL("../../../", import.meta.url);
const ref = new URL(requireEnv("SUPABASE_URL")).host.split(".")[0];
const cli = createRequire(import.meta.url).resolve("supabase/dist/supabase.js");

// Seules les variables nécessaires au fonctionnement de la CLI sous Windows, plus le jeton.
const childEnv: NodeJS.ProcessEnv = { SUPABASE_ACCESS_TOKEN: requireEnv("SUPABASE_ACCESS_TOKEN") };
for (const k of ["PATH", "Path", "SystemRoot", "USERPROFILE", "HOME", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "ProgramData"]) {
  if (process.env[k]) childEnv[k] = process.env[k];
}

function supabase(args: string[]): void {
  const r = spawnSync(process.execPath, [cli, ...args, "--project-ref", ref], {
    cwd: root, encoding: "utf8", env: childEnv,
  });
  // On n'affiche que le code de sortie et le message final, débarrassés du ref du projet.
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(ref).join("<ref>").trim().split("\n").slice(-2).join("\n");
  const label = `supabase ${args.slice(0, 2).join(" ")}`;
  if (r.status !== 0) throw new Error(`${label} → échec (${r.status})\n${tail}`);
  console.log(`${label} → ok`);
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
// Cerveau de l'assistant : Gemini (gratuit) et/ou Claude ; sans clé, seul l'interpréteur local répond.
for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "ANTHROPIC_API_KEY", "LLM_PROVIDER"]) {
  if (process.env[k]) secrets[k] = process.env[k]!;
}
if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.log("Aucune clé de modèle dans .env : seul l'interpréteur local répondra.");
}
// Facultatif : horaire de cours uOttawa (flux iCal), importé chaque matin par la fonction plan.
if (process.env.TIMETABLE_ICAL_URL) secrets.TIMETABLE_ICAL_URL = process.env.TIMETABLE_ICAL_URL;

const all = readdirSync(new URL("supabase/functions/", root), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !all.includes(n));
if (unknown.length) throw new Error(`Fonction inconnue : ${unknown.join(", ")}`);

const dir = mkdtempSync(join(tmpdir(), "jarvis-"));
try {
  const file = join(dir, "secrets.env");
  writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"), { mode: 0o600, flag: "wx" });
  supabase(["secrets", "set", "--env-file", file]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

for (const name of wanted.length ? wanted : all) {
  supabase(["functions", "deploy", name, "--no-verify-jwt", "--use-api"]);
}
