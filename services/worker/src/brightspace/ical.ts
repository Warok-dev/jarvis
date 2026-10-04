export type BrightspaceEventKind = "due" | "start" | "end" | "other";
export type BrightspaceItemType = "quiz" | "checklist" | "item";

export interface BrightspaceEvent {
  externalId: string; // UID iCal, stable entre deux lectures du flux
  kind: BrightspaceEventKind;
  itemType: BrightspaceItemType;
  title: string; // titre sans préfixe (« Questionnaire : ») ni suffixe (« – À échéance »)
  rawTitle: string;
  course: string | null; // nom complet tel que fourni par Brightspace
  courseCode: string | null; // ex. « CEG3555 »
  term: string | null; // ex. « 2026-automne »
  dueAt: Date | null; // échéance (fin de l'événement), null si absente
  startAt: Date | null;
  description: string | null;
  url: string | null;
}

// Suffixes ajoutés par Brightspace. Le séparateur varie selon l'outil :
// trait d'union, tiret demi-cadratin ou signe moins.
const SEP = String.raw`\s*[-–−]\s*`;
const KIND_SUFFIXES: Array<[RegExp, BrightspaceEventKind]> = [
  [new RegExp(`${SEP}(Dû|À échéance|Échéance|Due)\\.?\\s*$`, "i"), "due"],
  [new RegExp(`${SEP}(fin de la disponibilité|Availability Ends|End Date)\\.?\\s*$`, "i"), "end"],
  [new RegExp(`${SEP}(disponible|soumission autorisée|Available|Availability Starts|Start Date)\\.?\\s*$`, "i"), "start"],
];
const TYPE_PREFIXES: Array<[RegExp, BrightspaceItemType]> = [
  [/^Questionnaire\s*:\s*/i, "quiz"],
  [/^Liste de rappels\s*:\s*/i, "checklist"],
];

export function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/^webcal:\/\//i, "https://");
}

export async function fetchFeed(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(normalizeFeedUrl(url));
  } catch (err) {
    // On ne remonte jamais l'URL : elle contient le jeton d'accès.
    throw new Error(`Échec réseau en lisant le flux Brightspace (${(err as Error).name})`);
  }
  if (!res.ok) throw new Error(`Le flux Brightspace a répondu HTTP ${res.status}`);
  return res.text();
}

export function parseFeed(icsText: string): BrightspaceEvent[] {
  const events: BrightspaceEvent[] = [];

  for (const item of readVEvents(icsText)) {
    const uid = item.get("UID")?.value;
    if (!uid) continue;
    const rawTitle = text(item.get("SUMMARY")) ?? "(sans titre)";
    const { kind, itemType, title } = classify(rawTitle);
    const start = icsDate(item.get("DTSTART"));
    const end = icsDate(item.get("DTEND"));
    const course = text(item.get("LOCATION")) ?? null;

    events.push({
      externalId: uid,
      kind,
      itemType,
      title,
      rawTitle,
      course,
      courseCode: course ? parseCourseCode(course) : null,
      term: course ? parseTerm(course) : null,
      dueAt: end ?? start,
      startAt: start,
      description: text(item.get("DESCRIPTION")) ?? null,
      url: item.get("URL")?.value ?? null,
    });
  }

  return events.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
}

// --- Lecture iCal minimale (RFC 5545), sans dépendance : tourne sous Node et Deno. ---
// Les RRULE sont ignorées : seule la première occurrence compte pour une échéance.

interface Prop { value: string; params: Record<string, string> }

function* readVEvents(ics: string): Generator<Map<string, Prop>> {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/); // dépliage des lignes longues
  let current: Map<string, Prop> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") current = new Map();
    else if (line === "END:VEVENT") { if (current) yield current; current = null; }
    else if (current) {
      const p = parseLine(line);
      if (p && !current.has(p.name)) current.set(p.name, p.prop);
    }
  }
}

function parseLine(line: string): { name: string; prop: Prop } | null {
  // Le premier « : » hors guillemets sépare nom;paramètres et valeur.
  let quoted = false, i = 0;
  for (; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const [name, ...rawParams] = line.slice(0, i).split(";");
  const params: Record<string, string> = {};
  for (const rp of rawParams) {
    const eq = rp.indexOf("=");
    if (eq > 0) params[rp.slice(0, eq).toUpperCase()] = rp.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: name.toUpperCase(), prop: { value: line.slice(i + 1), params } };
}

const DEFAULT_TZ = "America/Toronto";

function icsDate(p: Prop | undefined): Date | null {
  const m = p?.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const parts = [+y, +mo - 1, +d, +h, +mi, +s] as const;
  if (z) return new Date(Date.UTC(...parts));
  // Heure locale (TZID) ou journée entière : interprétée dans le fuseau indiqué, sinon Toronto.
  return zonedToUtc(parts, p!.params.TZID ?? DEFAULT_TZ);
}

function zonedToUtc(parts: readonly [number, number, number, number, number, number], tz: string): Date {
  const asUtc = Date.UTC(...parts);
  let ts = asUtc - tzOffset(asUtc, tz);
  ts = asUtc - tzOffset(ts, tz); // seconde passe pour les changements d'heure
  return new Date(ts);
}

function tzOffset(ts: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const v = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second) - Math.floor(ts / 1000) * 1000;
}

function text(p: Prop | undefined): string | undefined {
  if (!p) return undefined;
  const v = p.value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c)).trim();
  return v || undefined;
}

function classify(rawTitle: string): { kind: BrightspaceEventKind; itemType: BrightspaceItemType; title: string } {
  let title = rawTitle.trim();
  let kind: BrightspaceEventKind = "other";
  let itemType: BrightspaceItemType = "item";
  for (const [re, k] of KIND_SUFFIXES) {
    if (re.test(title)) { kind = k; title = title.replace(re, "").trim(); break; }
  }
  for (const [re, t] of TYPE_PREFIXES) {
    if (re.test(title)) { itemType = t; title = title.replace(re, "").trim(); break; }
  }
  return { kind, itemType, title };
}

// « CEG3555  A02  Systèmes… », « GNG2501B - Intro… », « Automne 2026 - ELG3525 … »
export function parseCourseCode(course: string): string | null {
  return course.match(/\b([A-Z]{3})\s?(\d{4}[A-Z]?)\b/)?.slice(1).join("") ?? null;
}

// Code de session uOttawa en fin de nom : 2026 + 1 (hiver), 5 (printemps/été), 9 (automne).
const TERM_BY_DIGIT: Record<string, string> = { "1": "hiver", "5": "ete", "9": "automne" };
const TERM_BY_WORD: Record<string, string> = {
  hiver: "hiver", janvier: "hiver", printemps: "ete", "été": "ete", mai: "ete", automne: "automne", septembre: "automne",
};
export function parseTerm(course: string): string | null {
  const code = course.match(/\b(20\d{2})([159])\s*$/);
  if (code) return `${code[1]}-${TERM_BY_DIGIT[code[2]]}`;
  const word = course.toLowerCase().match(/(hiver|janvier|printemps|été|mai|automne|septembre)\s+(20\d{2})/);
  if (word) return `${word[2]}-${TERM_BY_WORD[word[1]]}`;
  return null;
}
