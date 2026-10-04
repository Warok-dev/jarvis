// Lit le flux iCal Brightspace depuis .env et affiche un résumé analysé.
// L'URL du flux n'est jamais affichée.
import { fetchFeed, parseFeed } from "../src/brightspace/ical.js";

const TZ = "America/Toronto";
const fmt = new Intl.DateTimeFormat("fr-CA", {
  timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});

const url = process.env.BRIGHTSPACE_ICAL_URL;
if (!url) {
  console.error("BRIGHTSPACE_ICAL_URL manquant : crée le fichier .env à la racine (voir .env.example).");
  process.exit(1);
}

const ics = await fetchFeed(url);
const events = parseFeed(ics);
const now = Date.now();

const count = <T>(list: T[], key: (x: T) => string) =>
  Object.fromEntries(Object.entries(Object.groupBy(list, key)).map(([k, v]) => [k, v!.length]));

console.log(`Flux lu : ${events.length} événements`);
console.log("Par type   :", count(events, (e) => e.kind));
console.log("Par session:", count(events, (e) => e.term ?? "inconnue"), "\n");

// Session courante = celle de l'échéance future la plus proche.
const nextDue = events.find((e) => e.term && e.dueAt && e.dueAt.getTime() >= now);
const term = nextDue?.term;
const current = events.filter((e) => e.term === term);

console.log(`Cours de la session ${term} :`);
for (const [code, n] of Object.entries(count(current, (e) => e.courseCode ?? e.course ?? "?"))) {
  console.log(`  ${String(n).padStart(3)}  ${code}`);
}

// Ce qui compte pour Jarvis : échéances et fins de disponibilité (questionnaires).
const upcoming = current.filter((e) => (e.kind === "due" || e.kind === "end") && e.dueAt && e.dueAt.getTime() >= now);
console.log(`\nÀ venir (${upcoming.length}) :`);
for (const e of upcoming) {
  const tag = e.itemType === "quiz" ? "quiz " : e.kind === "end" ? "fin  " : "     ";
  console.log(`  ${fmt.format(e.dueAt!).padEnd(24)} ${tag} ${(e.courseCode ?? "?").padEnd(8)} ${e.title}`);
}

const unclassified = current.filter((e) => e.kind === "other");
console.log(`\nNon classés dans la session (${unclassified.length}) :`);
for (const e of unclassified.slice(0, 10)) console.log(`  ${e.rawTitle}`);
