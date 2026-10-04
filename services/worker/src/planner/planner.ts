// Planificateur de révision : place des blocs de travail dans les créneaux libres,
// échéance la plus proche d'abord (EDF). Fonction pure, testée sans base de données.

export const TZ = "America/Toronto";
const MIN = 60_000;

export interface Window {
  weekday: number; // 0 = dimanche … 6 = samedi (heure de Toronto)
  start: string; // "18:00"
  end: string; // "22:00"
}

export interface Preferences {
  windows: Window[];
  maxBlockMinutes: number; // durée maximale d'un bloc
  minBlockMinutes: number; // en dessous, un créneau n'est pas utilisé
  breakMinutes: number; // pause entre deux blocs
  dailyCapMinutes: number; // travail planifié maximum par jour
  bufferBeforeDueMinutes: number; // finir avant l'échéance, avec une marge
}

export const DEFAULT_PREFERENCES: Preferences = {
  windows: [
    ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "18:00", end: "22:30" })),
    ...[0, 6].map((weekday) => ({ weekday, start: "10:00", end: "18:00" })),
  ],
  maxBlockMinutes: 90,
  minBlockMinutes: 30,
  breakMinutes: 15,
  dailyCapMinutes: 240,
  bufferBeforeDueMinutes: 120,
};

export interface Task {
  id: string;
  dueAt: Date;
  minutes: number; // reste à faire
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface Block extends Interval {
  taskId: string;
}

export interface PlanResult {
  blocks: Block[];
  unscheduled: Array<{ taskId: string; missingMinutes: number }>;
}

// --- Estimation de la durée d'un devoir à partir de son titre ---

const ESTIMATES: Array<[RegExp, number]> = [
  [/pr[ée][- ]?lab/i, 60],
  [/quiz|questionnaire|test/i, 45],
  [/livrable|projet|pr[ée]sentation|vid[ée]o|manuel/i, 360],
  [/rapport/i, 240],
  [/lab|soumission/i, 180],
  [/devoir|assignment|tp\b|travail/i, 240],
  [/r[ée]flexion|choix/i, 60],
];

export function estimateMinutes(title: string, itemType = "item"): number {
  if (itemType === "quiz") return 45;
  for (const [re, minutes] of ESTIMATES) if (re.test(title)) return minutes;
  return 120;
}

// Reste à faire selon le statut : « en cours » compte pour la moitié.
export function remainingMinutes(estimate: number, status: string): number {
  if (status === "done") return 0;
  return status === "in_progress" ? Math.ceil(estimate / 2 / 15) * 15 : estimate;
}

// --- Fuseau horaire ---

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
});
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: WEEKDAYS.indexOf(p.weekday) };
}

// Heure locale de Toronto → instant UTC (gère les changements d'heure).
export function torontoTime(y: number, m: number, d: number, h: number, min: number): Date {
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  const offset = (ts: number) => {
    const p = localParts(new Date(ts));
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000;
  };
  let ts = asUtc - offset(asUtc);
  ts = asUtc - offset(ts);
  return new Date(ts);
}

export function dayKey(d: Date): string {
  const p = localParts(d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

// --- Créneaux libres ---

function subtract(free: Interval[], busy: Interval[]): Interval[] {
  let out = free;
  for (const b of busy) {
    out = out.flatMap((f) => {
      if (b.end <= f.start || b.start >= f.end) return [f];
      const parts: Interval[] = [];
      if (b.start > f.start) parts.push({ start: f.start, end: b.start });
      if (b.end < f.end) parts.push({ start: b.end, end: f.end });
      return parts;
    });
  }
  return out;
}

export function freeIntervals(prefs: Preferences, busy: Interval[], from: Date, days: number): Interval[] {
  // Départ arrondi au quart d'heure suivant.
  const start = new Date(Math.ceil(from.getTime() / (15 * MIN)) * 15 * MIN);
  const out: Interval[] = [];
  const first = localParts(start);
  for (let i = 0; i <= days; i++) {
    const noon = torontoTime(first.y, first.m, first.d + i, 12, 0); // midi : jamais ambigu
    const p = localParts(noon);
    for (const w of prefs.windows.filter((w) => w.weekday === p.weekday)) {
      const [sh, sm] = w.start.split(":").map(Number);
      const [eh, em] = w.end.split(":").map(Number);
      const s = torontoTime(p.y, p.m, p.d, sh, sm);
      const e = torontoTime(p.y, p.m, p.d, eh, em);
      const clipped = { start: s < start ? start : s, end: e };
      if (clipped.end > clipped.start) out.push(clipped);
    }
  }
  return subtract(out, busy)
    .filter((i) => i.end.getTime() - i.start.getTime() >= prefs.minBlockMinutes * MIN)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

// --- Planification ---

export function plan(tasks: Task[], busy: Interval[], prefs: Preferences, now: Date, horizonDays = 14): PlanResult {
  const free = freeIntervals(prefs, busy, now, horizonDays).map((i) => ({ ...i }));
  const usedPerDay = new Map<string, number>();
  const blocks: Block[] = [];
  const unscheduled: PlanResult["unscheduled"] = [];

  const ordered = tasks.filter((t) => t.minutes > 0 && t.dueAt > now).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  for (const task of ordered) {
    let left = task.minutes;
    const limit = new Date(task.dueAt.getTime() - prefs.bufferBeforeDueMinutes * MIN);
    for (const slot of free) {
      if (left <= 0) break;
      while (left > 0 && slot.start < limit) {
        const day = dayKey(slot.start);
        const dayLeft = prefs.dailyCapMinutes - (usedPerDay.get(day) ?? 0);
        const slotEnd = slot.end < limit ? slot.end : limit;
        const room = Math.floor((slotEnd.getTime() - slot.start.getTime()) / MIN);
        const size = Math.min(left, prefs.maxBlockMinutes, room, dayLeft);
        // Un reste plus court que le minimum est quand même planifié s'il termine la tâche.
        if (size < prefs.minBlockMinutes && size < left) break;
        if (size <= 0) break;
        const end = new Date(slot.start.getTime() + size * MIN);
        blocks.push({ taskId: task.id, start: new Date(slot.start), end });
        usedPerDay.set(day, (usedPerDay.get(day) ?? 0) + size);
        left -= size;
        slot.start = new Date(end.getTime() + prefs.breakMinutes * MIN);
        if (slot.start >= slot.end) break;
      }
    }
    if (left > 0) unscheduled.push({ taskId: task.id, missingMinutes: left });
  }
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { blocks, unscheduled };
}
