// Exécute du SQL sur le projet via l'API de gestion Supabase (jeton SUPABASE_ACCESS_TOKEN).
// Usage : tsx scripts/sql.ts <fichier.sql>   ou   tsx scripts/sql.ts -e "select 1"
import { readFileSync } from "node:fs";
import { requireEnv } from "./env.ts";

export async function runSql(query: string): Promise<unknown> {
  const ref = new URL(requireEnv("SUPABASE_URL")).host.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("SUPABASE_ACCESS_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`SQL HTTP ${res.status} : ${JSON.stringify(body)}`);
  return body;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/sql.ts")) {
  const [flag, arg] = process.argv.slice(2);
  const query = flag === "-e" ? arg : readFileSync(flag, "utf8");
  console.log(JSON.stringify(await runSql(query), null, 1));
}
