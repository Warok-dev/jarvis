// Génère supabase/.local/setup-cron.sql : secrets Vault + migration 0002, à coller dans le SQL Editor.
// Le fichier contient un secret : il est ignoré par Git.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { requireEnv } from "./env.ts";

const root = new URL("../../../", import.meta.url);
const origin = new URL(requireEnv("SUPABASE_URL")).origin;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

const sql = `-- Généré par gen-cron-sql.ts — contient un secret, ne pas commiter.
select vault.create_secret(${quote(`${origin}/functions/v1/sync-brightspace`)}, 'jarvis_sync_url');
select vault.create_secret(${quote(requireEnv("CRON_SECRET"))}, 'jarvis_cron_secret');

${readFileSync(new URL("supabase/migrations/0002_cron_sync_brightspace.sql", root), "utf8")}`;

mkdirSync(new URL("supabase/.local/", root), { recursive: true });
writeFileSync(new URL("supabase/.local/setup-cron.sql", root), sql);
console.log("Écrit : supabase/.local/setup-cron.sql");
