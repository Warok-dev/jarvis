import type { AdminClient } from "../db.ts";
import { sendPush, type VapidKeys } from "../push/webpush.ts";
import { broadcast, topicFor } from "../devices/device-auth.ts";

// Décide quoi notifier et l'envoie. Appelé toutes les 5 min par pg_cron (fonction notify).
// Chaque notification a une dedup_key unique : relancer n'envoie jamais deux fois la même chose.

const TZ = "America/Toronto";
const QUIET_START = 23; // pas de push entre 23 h et 8 h : tout part au réveil
const QUIET_END = 8;
const EVENT_WINDOW_MS = 2 * 24 * 3600 * 1000;
const H = 3600 * 1000;

type Kind = "new_assignment" | "due_changed" | "reminder_24h" | "reminder_3h" | "daily_digest" | "skipped";

interface AssignmentLite {
  id: string;
  title: string;
  course_code: string | null;
  due_at: string | null;
  status: string;
  removed_at: string | null;
}

interface NotificationRow {
  user_id: string;
  dedup_key: string;
  kind: Kind;
  assignment_id: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string; // une notification par sujet : la suivante remplace la précédente
}

export interface NotifyResult {
  quiet: boolean;
  noSubscription: boolean;
  created: number;
  pushes: number;
  delivered: number;
  removedSubscriptions: number;
}

const hourFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", hourCycle: "h23" });
const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const DIGEST_UNTIL = 10; // récap envoyé au premier passage après 8 h, abandonné après 10 h
const dueFmt = new Intl.DateTimeFormat("fr-CA", {
  timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
});

export function isQuietHour(now: Date): boolean {
  const h = Number(hourFmt.format(now));
  return h >= QUIET_START || h < QUIET_END;
}

function label(a: AssignmentLite): string {
  return a.course_code ? `${a.course_code} · ${a.title}` : a.title;
}

function due(a: AssignmentLite): string {
  return a.due_at ? dueFmt.format(new Date(a.due_at)) : "sans échéance";
}

function inHours(a: AssignmentLite, now: Date): string {
  const h = (Date.parse(a.due_at!) - now.getTime()) / H;
  return h < 1 ? `dans ${Math.max(1, Math.round(h * 60))} min` : `dans ${Math.round(h)} h`;
}

// --- Choix des notifications (pur, testable) ---

export interface PendingEvent {
  id: number;
  type: "created" | "due_changed" | "restored";
  payload: { from?: string; to?: string };
  assignment: AssignmentLite;
}

export function planNotifications(
  userId: string,
  events: PendingEvent[],
  upcoming: AssignmentLite[],
  existingKeys: Set<string>,
  now: Date,
): NotificationRow[] {
  const rows: NotificationRow[] = [];
  const add = (r: Omit<NotificationRow, "user_id">) => {
    if (existingKeys.has(r.dedup_key)) return;
    existingKeys.add(r.dedup_key);
    rows.push({ user_id: userId, ...r });
  };
  const skip = (dedup_key: string, assignment_id: string) =>
    add({ dedup_key, kind: "skipped", assignment_id, title: null, body: null, url: null });

  for (const e of events) {
    const a = e.assignment;
    const key = `event:${e.id}`;
    const stale = !a.due_at || Date.parse(a.due_at) < now.getTime();
    if (a.removed_at || a.status === "done" || stale) { skip(key, a.id); continue; }

    if (e.type === "due_changed") {
      const from = e.payload.from ? dueFmt.format(new Date(e.payload.from)) : "aucune";
      add({
        dedup_key: key, kind: "due_changed", assignment_id: a.id,
        title: `Échéance modifiée · ${a.course_code ?? "cours"}`,
        body: `${a.title}\n${from} → ${due(a)}`,
        url: `/?a=${a.id}`,
      });
    } else {
      add({
        dedup_key: key, kind: "new_assignment", assignment_id: a.id,
        title: `Nouveau devoir · ${a.course_code ?? "cours"}`,
        body: `${a.title}\nÀ rendre ${due(a)}`,
        url: `/?a=${a.id}`,
      });
    }
  }

  for (const a of upcoming) {
    if (!a.due_at || a.status === "done" || a.removed_at) continue;
    const left = Date.parse(a.due_at) - now.getTime();
    if (left <= 0 || left > 24 * H) continue;
    const stamp = Date.parse(a.due_at);
    const k24 = `reminder_24h:${a.id}:${stamp}`;
    const k3 = `reminder_3h:${a.id}:${stamp}`;
    if (left <= 3 * H) {
      if (!existingKeys.has(k24)) skip(k24, a.id); // inutile d'envoyer « 24 h » après « 3 h »
      add({
        dedup_key: k3, kind: "reminder_3h", assignment_id: a.id,
        title: `À rendre ${inHours(a, now)} · ${a.course_code ?? "cours"}`,
        body: `${a.title}\n${a.status === "in_progress" ? "En cours — " : ""}${due(a)}`,
        url: `/?a=${a.id}`,
      });
    } else {
      add({
        dedup_key: k24, kind: "reminder_24h", assignment_id: a.id,
        title: `À rendre ${inHours(a, now)} · ${a.course_code ?? "cours"}`,
        body: `${a.title}\n${due(a)}`,
        url: `/?a=${a.id}`,
      });
    }
  }
  return rows;
}

// Récap du matin : ce qui est à rendre aujourd'hui et dans les 7 jours.
// Bloc du planning de révision prévu aujourd'hui (pour le récap).
export interface TodayBlock {
  starts_at: string;
  course_code: string | null;
  title: string;
}

const timeFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

export function planDigest(
  userId: string,
  week: AssignmentLite[],
  existingKeys: Set<string>,
  now: Date,
  todayBlocks: TodayBlock[] = [],
): NotificationRow | null {
  const hour = Number(hourFmt.format(now));
  const key = `digest:${dayFmt.format(now)}`;
  if (hour < QUIET_END || hour >= DIGEST_UNTIL || existingKeys.has(key)) return null;
  existingKeys.add(key);

  const pending = week
    .filter((a) => a.due_at && a.status !== "done" && !a.removed_at && Date.parse(a.due_at) > now.getTime())
    .sort((x, y) => Date.parse(x.due_at!) - Date.parse(y.due_at!));
  if (!pending.length) {
    return { user_id: userId, dedup_key: key, kind: "skipped", assignment_id: null, title: null, body: null, url: null };
  }
  const today = pending.filter((a) => dayFmt.format(new Date(a.due_at!)) === dayFmt.format(now));
  const title = today.length
    ? `Aujourd'hui : ${today.length} à rendre`
    : `Rien à rendre aujourd'hui · ${pending.length} cette semaine`;
  const lines = pending.slice(0, 4).map((a) => `${a.course_code ?? "—"} ${a.title} — ${due(a)}`);
  if (pending.length > 4) lines.push(`et ${pending.length - 4} autre(s) cette semaine`);
  if (todayBlocks.length) {
    const first = todayBlocks.slice(0, 2).map((b) => `${timeFmt.format(new Date(b.starts_at))} ${b.course_code ?? ""} ${b.title}`.replace(/\s+/g, " "));
    lines.push(`Au programme : ${first.join(", ")}${todayBlocks.length > 2 ? "…" : ""}`);
  }
  return { user_id: userId, dedup_key: key, kind: "daily_digest", assignment_id: null, title, body: lines.join("\n"), url: "/" };
}

// Regroupe les nouveaux devoirs d'un même passage en une seule notification.
export function toMessages(rows: NotificationRow[]): Array<{ message: PushMessage; ids: string[] }> {
  const sendable = rows.filter((r) => r.kind !== "skipped");
  const fresh = sendable.filter((r) => r.kind === "new_assignment");
  const others = sendable.filter((r) => r.kind !== "new_assignment");
  const out: Array<{ message: PushMessage; ids: string[] }> = [];

  if (fresh.length === 1) {
    const r = fresh[0];
    out.push({ message: { title: r.title!, body: r.body!, url: r.url!, tag: `a:${r.assignment_id}` }, ids: [r.dedup_key] });
  } else if (fresh.length > 1) {
    const lines = fresh.slice(0, 4).map((r) => `${r.title!.replace("Nouveau devoir · ", "")} — ${r.body!.split("\n")[0]}`);
    if (fresh.length > 4) lines.push(`et ${fresh.length - 4} autre(s)`);
    out.push({
      message: { title: `${fresh.length} nouveaux devoirs`, body: lines.join("\n"), url: "/", tag: "new-batch" },
      ids: fresh.map((r) => r.dedup_key),
    });
  }
  for (const r of others) {
    const tag = r.kind === "daily_digest" ? "digest" : `a:${r.assignment_id}`;
    out.push({ message: { title: r.title!, body: r.body!, url: r.url!, tag }, ids: [r.dedup_key] });
  }
  return out;
}

// --- Exécution ---

// Accès Realtime pour diffuser vers le PC (notifications Windows natives).
export interface RealtimeAccess {
  supabaseUrl: string;
  secretKey: string;
}

export async function runNotify(
  db: AdminClient,
  userId: string,
  vapid: VapidKeys,
  realtime: RealtimeAccess,
  now = new Date(),
): Promise<NotifyResult> {
  const result: NotifyResult = { quiet: false, noSubscription: false, created: 0, pushes: 0, delivered: 0, removedSubscriptions: 0 };
  if (isQuietHour(now)) return { ...result, quiet: true };

  // Sans appareil joignable, on ne consomme rien : tout partira au premier abonnement.
  const [subsRes, desktopsRes] = await Promise.all([
    db.from("push_subscriptions").select("id, endpoint, p256dh, auth, failure_count").eq("user_id", userId),
    db.from("devices").select("id, secret").eq("user_id", userId).eq("kind", "desktop")
      .gt("last_seen_at", new Date(now.getTime() - 3 * 60_000).toISOString()),
  ]);
  if (subsRes.error) throw new Error(`Lecture des abonnements : ${subsRes.error.message}`);
  if (desktopsRes.error) throw new Error(`Lecture des appareils : ${desktopsRes.error.message}`);
  const subs = subsRes.data;
  const desktopTopics = await Promise.all(desktopsRes.data.map((d) => topicFor(d.secret)));
  if (!subs.length && !desktopTopics.length) return { ...result, noSubscription: true };

  const cols = "id, title, course_code, due_at, status, removed_at";
  const [eventsRes, upcomingRes] = await Promise.all([
    db.from("assignment_events")
      .select(`id, type, payload, assignment:assignments(${cols})`)
      .eq("user_id", userId)
      .in("type", ["created", "due_changed", "restored"])
      .gte("created_at", new Date(now.getTime() - EVENT_WINDOW_MS).toISOString())
      .order("id"),
    db.from("assignments")
      .select(cols)
      .eq("user_id", userId)
      .is("removed_at", null)
      .neq("status", "done")
      .gt("due_at", now.toISOString())
      .lte("due_at", new Date(now.getTime() + 7 * 24 * H).toISOString()), // 7 j pour le récap, 24 h pour les rappels
  ]);
  if (eventsRes.error) throw new Error(`Lecture du journal : ${eventsRes.error.message}`);
  if (upcomingRes.error) throw new Error(`Lecture des échéances : ${upcomingRes.error.message}`);

  const events = eventsRes.data as unknown as PendingEvent[];
  const upcoming = upcomingRes.data as AssignmentLite[];

  const candidateKeys = [
    `digest:${dayFmt.format(now)}`,
    ...events.map((e) => `event:${e.id}`),
    ...upcoming.flatMap((a) => [`reminder_24h:${a.id}:${Date.parse(a.due_at!)}`, `reminder_3h:${a.id}:${Date.parse(a.due_at!)}`]),
  ];
  const existing = new Set<string>();
  if (candidateKeys.length) {
    const { data, error } = await db.from("notifications").select("dedup_key").eq("user_id", userId).in("dedup_key", candidateKeys);
    if (error) throw new Error(`Lecture des notifications : ${error.message}`);
    for (const r of data) existing.add(r.dedup_key);
  }

  // Blocs du planning prévus aujourd'hui (si le récap doit partir à ce passage).
  let todayBlocks: TodayBlock[] = [];
  if (!existing.has(`digest:${dayFmt.format(now)}`)) {
    const endOfDay = new Date(now.getTime() + 18 * H);
    const { data } = await db.from("study_blocks").select("starts_at, assignments(course_code, title, status)")
      .eq("user_id", userId).gte("starts_at", now.toISOString()).lte("starts_at", endOfDay.toISOString()).order("starts_at");
    todayBlocks = (data ?? [])
      .map((b) => ({ starts_at: b.starts_at, a: b.assignments as unknown as { course_code: string | null; title: string; status: string } }))
      .filter((b) => b.a && b.a.status !== "done" && dayFmt.format(new Date(b.starts_at)) === dayFmt.format(now))
      .map((b) => ({ starts_at: b.starts_at, course_code: b.a.course_code, title: b.a.title }));
  }
  const digest = planDigest(userId, upcoming, existing, now, todayBlocks);
  const planned = [...(digest ? [digest] : []), ...planNotifications(userId, events, upcoming, existing, now)];
  if (!planned.length) return result;

  // ignoreDuplicates : si deux passages tournent en même temps, un seul « gagne » chaque clé.
  const { data: inserted, error: insErr } = await db
    .from("notifications")
    .upsert(planned, { onConflict: "user_id,dedup_key", ignoreDuplicates: true })
    .select("dedup_key, kind, assignment_id, title, body, url, user_id");
  if (insErr) throw new Error(`Écriture des notifications : ${insErr.message}`);
  result.created = inserted.length;

  const messages = toMessages(inserted as NotificationRow[]);
  if (!messages.length) return result;

  for (const { message, ids } of messages) {
    result.pushes++;
    let delivered = false;
    for (const s of subs) {
      const r = await sendPush(s, message, vapid, { urgency: "high", topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) });
      if (r.ok) {
        delivered = true;
        await db.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq("id", s.id);
      } else if (r.gone) {
        await db.from("push_subscriptions").delete().eq("id", s.id);
        result.removedSubscriptions++;
      } else {
        console.error("push refusé", r.status, r.body);
        await db.from("push_subscriptions").update({ failure_count: s.failure_count + 1 }).eq("id", s.id);
      }
    }
    // PC allumé : notification Windows native via son canal temps réel.
    for (const topic of desktopTopics) {
      if (await broadcast(realtime.supabaseUrl, realtime.secretKey, topic, "notification", { ...message })) delivered = true;
    }
    if (delivered) {
      result.delivered++;
      await db.from("notifications").update({ sent_at: new Date().toISOString() }).eq("user_id", userId).in("dedup_key", ids);
    }
  }
  return result;
}
