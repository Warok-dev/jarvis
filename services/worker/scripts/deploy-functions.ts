// Pousse les secrets depuis .env puis déploie les Edge Functions. Rien de secret n'est affiché.
// Usage : tsx scripts/deploy-functions.ts [nom…]   (par défaut : toutes)
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
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

const secrets = {
  JARVIS_SECRET_KEY: requireEnv("SUPABASE_SECRET_KEY"),
  JARVIS_USER_ID: requireEnv("SUPABASE_USER_ID"),
  BRIGHTSPACE_ICAL_URL: requireEnv("BRIGHTSPACE_ICAL_URL"),
  CRON_SECRET: requireEnv("CRON_SECRET"),
  VAPID_PUBLIC_KEY: requireEnv("VAPID_PUBLIC_KEY"),
  VAPID_PRIVATE_KEY: requireEnv("VAPID_PRIVATE_KEY"),
  VAPID_SUBJECT: requireEnv("VAPID_SUBJECT"),
};
const file = join(tmpdir(), `jarvis-secrets-${process.pid}.env`);
writeFileSync(file, Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"));
try { supabase(["secrets", "set", "--env-file", file]); } finally { rmSync(file); }

const all = readdirSync(new URL("supabase/functions/", root), { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
for (const name of process.argv.slice(2).length ? process.argv.slice(2) : all) {
  supabase(["functions", "deploy", name, "--no-verify-jwt", "--use-api"]);
}
