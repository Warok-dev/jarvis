import { supabase } from "./supabase";
import { currentDevice } from "./device";

export type Status = "todo" | "in_progress" | "done";

export interface Assignment {
  id: string;
  course_code: string | null;
  title: string;
  item_type: "item" | "quiz" | "checklist";
  due_at: string | null;
  status: Status;
  url: string | null;
  removed_at: string | null;
  estimated_minutes: number | null;
}

const COLUMNS = "id, course_code, title, item_type, due_at, status, url, removed_at, estimated_minutes";

export async function fetchAssignments(): Promise<Assignment[]> {
  const { data, error } = await supabase
    .from("assignments")
    .select(COLUMNS)
    .is("removed_at", null)
    .order("due_at", { ascending: true });
  if (error) throw error;
  return data as Assignment[];
}

export async function setStatus(id: string, status: Status): Promise<void> {
  const { error } = await supabase
    .from("assignments")
    .update({ status, status_changed_by: currentDevice() })
    .eq("id", id);
  if (error) throw error;
}

// Écoute les changements faits ailleurs (PC, worker, autre onglet).
export function subscribeAssignments(userId: string, onChange: (row: Assignment) => void) {
  const channel = supabase
    .channel(`assignments:${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "assignments", filter: `user_id=eq.${userId}` },
      (payload) => {
        if (payload.new && "id" in payload.new) onChange(payload.new as Assignment);
      },
    )
    .subscribe();
  return () => void supabase.removeChannel(channel);
}

// --- Regroupement pour l'affichage ---

export type GroupKey = "late" | "today" | "week" | "later" | "done";

export const GROUP_LABELS: Record<GroupKey, string> = {
  late: "En retard",
  today: "Aujourd'hui",
  week: "7 prochains jours",
  later: "Plus tard",
  done: "Terminés",
};

const TZ = "America/Toronto";
const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function groupOf(a: Assignment, now = new Date()): GroupKey {
  if (a.status === "done") return "done";
  if (!a.due_at) return "later";
  const due = new Date(a.due_at);
  if (due < now) return "late";
  if (dayKey.format(due) === dayKey.format(now)) return "today";
  if (due.getTime() - now.getTime() < 7 * 864e5) return "week";
  return "later";
}

const dateFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export function formatDue(iso: string | null, now = new Date()): { date: string; relative: string } {
  if (!iso) return { date: "Sans échéance", relative: "" };
  const due = new Date(iso);
  const date = `${dateFmt.format(due)} · ${timeFmt.format(due)}`;
  const diffH = (due.getTime() - now.getTime()) / 36e5;
  let relative: string;
  if (diffH < 0) relative = diffH > -24 ? `il y a ${Math.round(-diffH)} h` : `il y a ${Math.round(-diffH / 24)} j`;
  else if (diffH < 1) relative = `dans ${Math.max(1, Math.round(diffH * 60))} min`;
  else if (diffH < 24) relative = `dans ${Math.round(diffH)} h`;
  else relative = `dans ${Math.round(diffH / 24)} j`;
  return { date, relative };
}
