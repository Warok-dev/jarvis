// Interpréteur local des demandes courantes : gratuit, instantané, sans modèle de langage.
// Il ne répond que s'il est sûr de lui ; sinon il renvoie null et la demande part au modèle.

export type Intent =
  | { kind: "upcoming"; days: number; label: string }
  | { kind: "plan" }
  | { kind: "status"; status: "done" | "in_progress"; query: string }
  | { kind: "open_app"; app: string };

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Mots de liaison ignorés pour retrouver un devoir (« le lab 1 d'ELG » → lab, 1, elg).
const STOPWORDS = new Set([
  "le", "la", "les", "l", "un", "une", "de", "du", "des", "d", "en", "pour", "mon", "ma", "mes", "ce", "cette",
  "cours", "au", "a", "et", "j", "ai", "c", "est", "bon", "fait", "deja", "enfin", "aussi", "avec",
]);

// Une phrase qui enchaîne plusieurs demandes ou pose une vraie question part au modèle.
const COMPLEX = /\b(et puis|ensuite|pourquoi|comment|explique|resume|donne|envoie|planifie|reorganise|combien|si )\b/;

export function parseIntent(raw: string): Intent | null {
  const t = normalize(raw);
  if (!t || t.length > 90 || COMPLEX.test(t)) return null;

  // « ouvre VS Code », « lance chrome »
  const open = t.match(/^(?:jarvis )?(?:ouvre|ouvrir|lance|lancer|demarre)(?: moi)? (?:l app |le |la |l )?(.+)$/);
  if (open && !/ et /.test(open[1])) return { kind: "open_app", app: open[1] };

  // « j'ai fini le lab 1 d'ELG », « je commence le devoir 2 »
  const done = t.match(/^(?:c est bon )?(?:j ai|je viens de)? ?(?:fini|termine|rendu|remis|complete|soumis)(?: avec)? (.+)$/);
  if (done) return { kind: "status", status: "done", query: done[1] };
  const started = t.match(/^(?:je (?:commence|attaque|m occupe de|suis sur|travaille sur)|j ai commence) (.+)$/);
  if (started && !/\b(quoi|quand)\b/.test(started[1])) return { kind: "status", status: "in_progress", query: started[1] };

  // Planning de révision
  if (/\b(planning|au programme)\b|je (travaille|bosse|revise) (sur )?quoi|qu est ce que je (travaille|revise|fais) (ce soir|aujourd hui|maintenant)/.test(t)) {
    return { kind: "plan" };
  }

  // Échéances
  if (/(qu est ce que j ai|j ai quoi|quoi|qu est ce qu il y a)( a)? (a )?(rendre|faire|remettre)|mes devoirs|mes echeances|echeances|c est pour quand|a rendre/.test(t)) {
    if (/\baujourd hui\b|\bce soir\b/.test(t)) return { kind: "upcoming", days: 0, label: "aujourd'hui" };
    if (/\bdemain\b/.test(t)) return { kind: "upcoming", days: 1, label: "demain" };
    if (/\bmois\b/.test(t)) return { kind: "upcoming", days: 30, label: "ce mois-ci" };
    return { kind: "upcoming", days: 7, label: "cette semaine" };
  }
  return null;
}

export interface Candidate {
  id: string;
  title: string;
  course_code: string | null;
}

function tokensOf(c: Candidate): Set<string> {
  const set = new Set(normalize(c.title).split(" "));
  if (c.course_code) {
    const code = normalize(c.course_code).replace(/ /g, "");
    set.add(code); // ceg3555
    const m = code.match(/^([a-z]+)(\d+)/);
    if (m) { set.add(m[1]); set.add(m[2]); } // ceg, 3555
  }
  return set;
}

// Retrouve LE devoir désigné : tous les mots utiles doivent correspondre, et un seul devoir doit
// correspondre au mieux. En cas d'ambiguïté (« le devoir 1 » : Devoir 1 ou Devoir d'économie 1 ?) → null.
export function matchAssignment<T extends Candidate>(query: string, candidates: T[]): T | null {
  const words = normalize(query).split(" ").filter((w) => w && !STOPWORDS.has(w));
  if (!words.length) return null;
  let best: T[] = [];
  let bestScore = 0;
  for (const c of candidates) {
    const tokens = tokensOf(c);
    const score = words.filter((w) => tokens.has(w)).length;
    if (score > bestScore) { bestScore = score; best = [c]; }
    else if (score === bestScore && score > 0) best.push(c);
  }
  if (bestScore < words.length || best.length !== 1) return null;
  // Les devoirs dont le titre contient d'autres mots que ceux cités restent acceptés,
  // sauf si un autre devoir contient aussi tous les mots cités (déjà exclu ci-dessus).
  return best[0];
}

export interface AppRef {
  id: string;
  label: string;
}

export function matchApp(query: string, apps: AppRef[]): AppRef | null {
  const q = normalize(query).replace(/ /g, "");
  const found = apps.filter((a) => {
    const id = normalize(a.id).replace(/ /g, "");
    const label = normalize(a.label).replace(/ /g, "");
    return q === id || label.startsWith(q) || label.includes(q) || (q.length >= 3 && id.startsWith(q));
  });
  return found.length === 1 ? found[0] : null;
}

// --- Formulation orale ---

const TZ = "America/Toronto";
const hourFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, weekday: "long" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

// « 19 h », « 20 h 30 », « avant minuit »
export function spokenTime(d: Date): string {
  const s = hourFmt.format(d).replace(/\s*h\s*00$/, " h").replace(" h ", " h ");
  return /^23 h 59/.test(s) ? "avant minuit" : `à ${s}`;
}

export function spokenDay(d: Date, now: Date): string {
  const k = keyFmt.format(d);
  if (k === keyFmt.format(now)) return "aujourd'hui";
  if (k === keyFmt.format(new Date(now.getTime() + 864e5))) return "demain";
  return dayFmt.format(d);
}

export function joinFr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} et ${items[items.length - 1]}`;
}
