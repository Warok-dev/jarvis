import { supabase } from "./supabase";

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
