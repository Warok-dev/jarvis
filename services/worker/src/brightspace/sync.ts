import type { AdminClient } from "../db.ts";
import type { BrightspaceEvent } from "./ical.ts";

const SOURCE = "brightspace_ical";
// Les échéances passées depuis plus longtemps que ça sont ignorées (anciennes sessions).
const LOOKBACK_MS = 14 * 24 * 3600 * 1000;

export interface SyncResult {
  seen: number;
  created: number;
  updated: number;
  removed: number;
  restored: number;
}

interface Row {
  user_id: string;
  source: string;
  external_id: string;
  course_code: string | null;
  course_name: string | null;
  term: string | null;
  title: string;
  item_type: string;
  due_at: string | null;
  description: string | null;
  url: string | null;
}

type Existing = Row & { id: string; removed_at: string | null };

const TRACKED_FIELDS = ["course_code", "course_name", "term", "title", "item_type", "due_at", "description", "url"] as const;

// Ne garde que ce qui est une vraie date limite : échéances, et fins de disponibilité des questionnaires.
export function selectDeadlines(events: BrightspaceEvent[], now = Date.now()): BrightspaceEvent[] {
  const deadlines = events.filter(
    (e) => e.dueAt && e.dueAt.getTime() >= now - LOOKBACK_MS && (e.kind === "due" || (e.kind === "end" && e.itemType === "quiz")),
  );

  // Brightspace publie parfois le même élément deux fois (travail + questionnaire, même heure).
  const byKey = new Map<string, BrightspaceEvent>();
  for (const e of deadlines) {
    const key = `${e.courseCode}|${e.title.toLowerCase()}|${e.dueAt!.getTime()}`;
    const prev = byKey.get(key);
    if (!prev || (prev.kind !== "due" && e.kind === "due")) byKey.set(key, e);
  }
  return [...byKey.values()];
}

function toRow(e: BrightspaceEvent, userId: string): Row {
  return {
    user_id: userId,
    source: SOURCE,
    external_id: e.externalId,
    course_code: e.courseCode,
    course_name: e.course,
    term: e.term,
    title: e.title,
    item_type: e.itemType,
    due_at: e.dueAt?.toISOString() ?? null,
    description: e.description,
    url: e.url,
  };
}

function differs(row: Row, existing: Existing): boolean {
  return TRACKED_FIELDS.some((f) =>
    f === "due_at"
      ? (row.due_at ? Date.parse(row.due_at) : null) !== (existing.due_at ? Date.parse(existing.due_at) : null)
      : row[f] !== existing[f],
  );
}

export async function syncBrightspace(db: AdminClient, userId: string, events: BrightspaceEvent[]): Promise<SyncResult> {
  const now = Date.now();
  const rows = selectDeadlines(events, now).map((e) => toRow(e, userId));

  const { data: existingData, error } = await db
    .from("assignments")
    .select(`id, removed_at, user_id, source, external_id, ${TRACKED_FIELDS.join(", ")}`)
    .eq("user_id", userId)
    .eq("source", SOURCE);
  if (error) throw new Error(`Lecture des devoirs : ${error.message}`);
  const existing = new Map((existingData as unknown as Existing[]).map((r) => [r.external_id, r]));

  const toCreate: Row[] = [];
  const toUpdate: Row[] = [];
  const toRestore: string[] = [];
  for (const row of rows) {
    const prev = existing.get(row.external_id);
    if (!prev) toCreate.push(row);
    else {
      if (differs(row, prev)) toUpdate.push(row);
      if (prev.removed_at) toRestore.push(prev.id);
    }
  }

  // Disparu du flux alors que l'échéance est encore dans la fenêtre : masqué ou supprimé par le prof.
  const feedIds = new Set(rows.map((r) => r.external_id));
  const toRemove = [...existing.values()]
    .filter((r) => !r.removed_at && !feedIds.has(r.external_id) && r.due_at && Date.parse(r.due_at) >= now - LOOKBACK_MS)
    .map((r) => r.id);

  // L'upsert n'envoie jamais le statut : celui choisi par l'utilisateur est conservé.
  const upserts = [...toCreate, ...toUpdate];
  if (upserts.length) {
    const { error: e } = await db.from("assignments").upsert(upserts, { onConflict: "user_id,source,external_id" });
    if (e) throw new Error(`Écriture des devoirs : ${e.message}`);
  }
  if (toRemove.length) {
    const { error: e } = await db.from("assignments").update({ removed_at: new Date(now).toISOString() }).in("id", toRemove);
    if (e) throw new Error(`Retrait des devoirs : ${e.message}`);
  }
  if (toRestore.length) {
    const { error: e } = await db.from("assignments").update({ removed_at: null }).in("id", toRestore);
    if (e) throw new Error(`Rétablissement des devoirs : ${e.message}`);
  }

  return { seen: rows.length, created: toCreate.length, updated: toUpdate.length, removed: toRemove.length, restored: toRestore.length };
}
