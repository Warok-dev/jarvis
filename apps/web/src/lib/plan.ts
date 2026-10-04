import { supabase } from "./supabase";
import { DEFAULT_PREFERENCES, type Preferences } from "../../../../services/worker/src/planner/planner.ts";

export { estimateMinutes } from "../../../../services/worker/src/planner/planner.ts";
export type { Preferences };

export interface StudyBlock {
  id: number;
  assignment_id: string;
  starts_at: string;
  ends_at: string;
}

export interface PlanData {
  blocks: StudyBlock[];
  unscheduled: Array<{ taskId: string; missingMinutes: number }>;
  computedAt: string | null;
}

export async function fetchPlan(days = 7): Promise<PlanData> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 864e5);
  const [blocks, run] = await Promise.all([
    supabase.from("study_blocks").select("id, assignment_id, starts_at, ends_at")
      .gte("ends_at", now.toISOString()).lte("starts_at", until.toISOString()).order("starts_at"),
    supabase.from("study_plan_runs").select("computed_at, unscheduled").maybeSingle(),
  ]);
  if (blocks.error) throw blocks.error;
  return {
    blocks: blocks.data as StudyBlock[],
    unscheduled: (run.data?.unscheduled ?? []) as PlanData["unscheduled"],
    computedAt: run.data?.computed_at ?? null,
  };
}

export async function replan(): Promise<void> {
  const { error } = await supabase.functions.invoke("plan");
  if (error) throw error;
}

export async function fetchPreferences(): Promise<Preferences> {
  const { data } = await supabase.from("study_preferences").select("prefs").maybeSingle();
  return { ...DEFAULT_PREFERENCES, ...(data?.prefs ?? {}) };
}

export async function savePreferences(prefs: Preferences): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Session expirée");
  const { error } = await supabase.from("study_preferences").upsert({ user_id: user.id, prefs, updated_at: new Date().toISOString() });
  if (error) throw error;
}

export async function setEstimate(id: string, minutes: number | null): Promise<void> {
  const { error } = await supabase.from("assignments").update({ estimated_minutes: minutes }).eq("id", id);
  if (error) throw error;
}
