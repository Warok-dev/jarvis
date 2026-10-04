// Une synchronisation complète : flux Brightspace → table assignments, puis affiche les derniers événements.
import { adminClient, requireEnv } from "./env.ts";
import { fetchFeed, parseFeed } from "../src/brightspace/ical.ts";
import { syncBrightspace } from "../src/brightspace/sync.ts";

const db = adminClient();
const userId = requireEnv("SUPABASE_USER_ID");

const events = parseFeed(await fetchFeed(requireEnv("BRIGHTSPACE_ICAL_URL")));
const result = await syncBrightspace(db, userId, events);
console.log("Synchronisation :", result);

const { data, error } = await db
  .from("assignment_events")
  .select("type, payload, created_at, assignments(course_code, title)")
  .eq("user_id", userId)
  .order("created_at", { ascending: false })
  .limit(8);
if (error) throw new Error(error.message);

console.log("\nDerniers événements :");
for (const e of data ?? []) {
  const a = e.assignments as unknown as { course_code: string; title: string } | null;
  console.log(`  ${e.type.padEnd(15)} ${(a?.course_code ?? "?").padEnd(8)} ${a?.title ?? ""}`);
}
