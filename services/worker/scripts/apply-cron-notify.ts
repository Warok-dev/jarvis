// Enregistre l'URL de notify dans Vault puis applique la migration 0004 (planification).
import { readFileSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { runSql } from "./sql.ts";

const url = `${new URL(requireEnv("SUPABASE_URL")).origin}/functions/v1/notify`;
await runSql(`
  select vault.create_secret('${url}', 'jarvis_notify_url')
  where not exists (select 1 from vault.secrets where name = 'jarvis_notify_url');
`);
await runSql(readFileSync(new URL("../../../supabase/migrations/0004_cron_notify.sql", import.meta.url), "utf8"));
console.log(await runSql("select jobname, schedule, active from cron.job order by jobid"));
