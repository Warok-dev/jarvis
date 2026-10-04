import type { AdminClient } from "../db.ts";
import { parseFeed } from "../brightspace/ical.ts";
import { DEFAULT_PREFERENCES, estimateMinutes, plan, remainingMinutes, type Preferences } from "./planner.ts";

const HORIZON_DAYS = 14;
const DAY = 24 * 3600 * 1000;

export interface PlanSummary {
  blocks: number;
  tasks: number;
  unscheduled: number;
}

// Recalcule le planning des 14 prochains jours et remplace les blocs futurs.
export async function runPlan(db: AdminClient, userId: string, now = new Date()): Promise<PlanSummary> {
  const horizon = new Date(now.getTime() + HORIZON_DAYS * DAY);
  const [assignmentsRes, busyRes, prefsRes] = await Promise.all([
    // Toutes les échéances à venir : une tâche due après l'horizon peut déjà demander du travail.
    db.from("assignments").select("id, title, item_type, due_at, status, estimated_minutes")
      .eq("user_id", userId).is("removed_at", null).neq("status", "done").gt("due_at", now.toISOString())
      .lte("due_at", new Date(horizon.getTime() + 7 * DAY).toISOString()),
    db.from("busy_blocks").select("starts_at, ends_at").eq("user_id", userId)
      .lt("starts_at", horizon.toISOString()).gt("ends_at", now.toISOString()),
    db.from("study_preferences").select("prefs").eq("user_id", userId).maybeSingle(),
  ]);
  for (const r of [assignmentsRes, busyRes, prefsRes]) if (r.error) throw new Error(r.error.message);

  const prefs: Preferences = { ...DEFAULT_PREFERENCES, ...(prefsRes.data?.prefs ?? {}) };
  const tasks = assignmentsRes.data!.map((a) => ({
    id: a.id,
    dueAt: new Date(a.due_at),
    minutes: remainingMinutes(a.estimated_minutes ?? estimateMinutes(a.title, a.item_type), a.status),
  }));
  const busy = busyRes.data!.map((b) => ({ start: new Date(b.starts_at), end: new Date(b.ends_at) }));
  const result = plan(tasks, busy, prefs, now, HORIZON_DAYS);

  // Les blocs passés restent (historique) ; les blocs futurs sont remplacés.
  const del = await db.from("study_blocks").delete().eq("user_id", userId).gte("starts_at", now.toISOString());
  if (del.error) throw new Error(del.error.message);
  if (result.blocks.length) {
    const ins = await db.from("study_blocks").insert(result.blocks.map((b) => ({
      user_id: userId, assignment_id: b.taskId, starts_at: b.start.toISOString(), ends_at: b.end.toISOString(),
    })));
    if (ins.error) throw new Error(ins.error.message);
  }
  const run = await db.from("study_plan_runs").upsert({
    user_id: userId, computed_at: now.toISOString(), unscheduled: result.unscheduled,
  });
  if (run.error) throw new Error(run.error.message);
  return { blocks: result.blocks.length, tasks: tasks.length, unscheduled: result.unscheduled.length };
}

// Importe l'horaire de cours (flux iCal) comme créneaux occupés.
export async function syncTimetable(db: AdminClient, userId: string, icsText: string, now = new Date()): Promise<number> {
  const from = new Date(now.getTime() - DAY);
  const rows = parseFeed(icsText)
    .filter((e) => e.startAt && e.dueAt && e.dueAt > e.startAt && e.dueAt > from)
    .map((e) => ({
      user_id: userId, source: "timetable", external_id: e.externalId,
      title: e.rawTitle.slice(0, 200), starts_at: e.startAt!.toISOString(), ends_at: e.dueAt!.toISOString(),
    }));
  if (rows.length) {
    const { error } = await db.from("busy_blocks").upsert(rows, { onConflict: "user_id,source,external_id" });
    if (error) throw new Error(error.message);
  }
  // Cours retirés de l'horaire : on supprime les créneaux futurs qui n'y sont plus.
  const keep = new Set(rows.map((r) => r.external_id));
  const { data: existing } = await db.from("busy_blocks").select("id, external_id")
    .eq("user_id", userId).eq("source", "timetable").gte("starts_at", now.toISOString());
  const stale = (existing ?? []).filter((r) => !keep.has(r.external_id)).map((r) => r.id);
  if (stale.length) await db.from("busy_blocks").delete().in("id", stale);
  return rows.length;
}
