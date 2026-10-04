import ical from "node-ical";

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
  const data = ical.sync.parseICS(icsText);
  const events: BrightspaceEvent[] = [];

  for (const item of Object.values(data)) {
    if (!item || item.type !== "VEVENT") continue;
    const rawTitle = text(item.summary) ?? "(sans titre)";
    const { kind, itemType, title } = classify(rawTitle);
    const start = item.start ? new Date(item.start) : null;
    const end = item.end ? new Date(item.end) : null;
    const course = text(item.location) ?? null;

    events.push({
      externalId: item.uid,
      kind,
      itemType,
      title,
      rawTitle,
      course,
      courseCode: course ? parseCourseCode(course) : null,
      term: course ? parseTerm(course) : null,
      dueAt: end ?? start,
      startAt: start,
      description: text(item.description) ?? null,
      url: text((item as { url?: unknown }).url) ?? null,
    });
  }

  return events.sort((a, b) => (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0));
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

// node-ical renvoie parfois { val, params } au lieu d'une chaîne.
function text(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "object" && "val" in v) return text((v as { val: unknown }).val);
  return String(v);
}
