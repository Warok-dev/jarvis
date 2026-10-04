// Enregistre l'URL de la fonction plan dans Vault puis applique la migration 0009.
import { readFileSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { runSql } from "./sql.ts";

const url = `${new URL(requireEnv("SUPABASE_URL")).origin}/functions/v1/plan`;
await runSql(`
  select vault.create_secret('${url}', 'jarvis_plan_url')
  where not exists (select 1 from vault.secrets where name = 'jarvis_plan_url');
`);
await runSql(readFileSync(new URL("../../../supabase/migrations/0009_cron_plan.sql", import.meta.url), "utf8"));
console.log(await runSql("select jobname, schedule, active from cron.job order by jobid"));
