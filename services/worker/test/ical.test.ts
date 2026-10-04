// Parseur iCal : formats réellement observés dans le flux Brightspace d'uOttawa.
import assert from "node:assert/strict";
import { parseCourseCode, parseFeed, parseTerm } from "../src/brightspace/ical.ts";
import { selectDeadlines } from "../src/brightspace/sync.ts";

const BS = String.fromCharCode(92); // barre oblique inverse, sans piège d'échappement
const ev = (uid: string, summary: string, location: string, dt: string, extra: string[] = []) =>
  ["BEGIN:VEVENT", `UID:${uid}`, `SUMMARY:${summary}`, `LOCATION:${location}`, `DTSTART:${dt}`, `DTEND:${dt}`, ...extra, "END:VEVENT"];
const ics = [
  "BEGIN:VCALENDAR", "VERSION:2.0",
  ...ev("1", "Pre-lab soudage - Dû", "GNG2501B - Intro dével produits génie & info 20269", "20260930T230000Z"),
  ...ev("2", "Devoir 1 – À échéance", "CEG3555  A02  Systèmes numériques II 20269", "20261006T000000Z"),
  ...ev("3", "CEG 3555 Questionnaire 1 − Échéance", "CEG3555  A02  Systèmes numériques II 20269", "20260930T131000Z"),
  ...ev("4", "Questionnaire : Quiz4Particip – fin de la disponibilité", "CEG3536  A02  Architecture d'ordinateurs ii 20269", "20261014T163000Z"),
  ...ev("5", "Questionnaire : Quiz4Particip – disponible", "CEG3536  A02  Architecture d'ordinateurs ii 20269", "20261002T154500Z"),
  ...ev("6", "Lab 1 – À échéance", "Automne 2026 - ELG3525  Analyse des signaux et syst.", "20261006T035959Z"),
  ...ev("7", "Début du trimestre d'automne - Start of fall term", "Université d'Ottawa | University of Ottawa", "20260902T040000Z"),
  // Doublon Brightspace : même élément publié comme travail et comme questionnaire.
  ...ev("8a", "Pre-lab fraiseuse/tour (lab 1) − Échéance", "GNG2501B - Intro dével produits génie & info 20269", "20261105T000000Z"),
  ...ev("8b", "Questionnaire : Pre-lab fraiseuse/tour (lab 1) – fin de la disponibilité", "GNG2501B - Intro dével produits génie & info 20269", "20261105T000000Z"),
  // Journée entière, ligne repliée et caractères échappés.
  "BEGIN:VEVENT", "UID:9", `SUMMARY:Projet${BS}, partie 1 - Dû`, "LOCATION:FRA1528  A  Rédaction technique (septembre 2026)",
  "DTSTART;VALUE=DATE:20261102", `DESCRIPTION:ligne 1${BS}nligne`, "  2", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const byId = new Map(parseFeed(ics).map((e) => [e.externalId, e]));

assert.deepEqual([byId.get("1")!.kind, byId.get("1")!.title, byId.get("1")!.courseCode, byId.get("1")!.term], ["due", "Pre-lab soudage", "GNG2501B", "2026-automne"]);
assert.equal(byId.get("2")!.kind, "due");
assert.equal(byId.get("3")!.title, "CEG 3555 Questionnaire 1");
assert.deepEqual([byId.get("4")!.kind, byId.get("4")!.itemType, byId.get("4")!.title], ["end", "quiz", "Quiz4Particip"]);
assert.equal(byId.get("5")!.kind, "start");
assert.deepEqual([byId.get("6")!.courseCode, byId.get("6")!.term], ["ELG3525", "2026-automne"]);
assert.deepEqual([byId.get("7")!.kind, byId.get("7")!.courseCode, byId.get("7")!.term], ["other", null, null]);
assert.equal(byId.get("9")!.title, "Projet, partie 1");
assert.equal(byId.get("9")!.description, "ligne 1\nligne 2");
assert.equal(byId.get("9")!.term, "2026-automne");
assert.equal(byId.get("9")!.dueAt!.toISOString(), "2026-11-02T05:00:00.000Z"); // minuit à Toronto, heure normale

assert.equal(parseCourseCode("SEG2506  A00  Construction de logiciels [ LEC ] 20261"), "SEG2506");
assert.equal(parseTerm("SEG2506  A00  Construction de logiciels [ LEC ] 20261"), "2026-hiver");
assert.equal(parseTerm("Principes de chimie (automne 2024)"), "2024-automne");

// Sélection des échéances : passé lointain exclu, « disponible » exclu, doublon fusionné.
const deadlines = selectDeadlines(parseFeed(ics), Date.parse("2026-10-03T12:00:00Z"));
const ids = deadlines.map((e) => e.externalId).sort();
assert.deepEqual(ids, ["1", "2", "3", "4", "6", "8a", "9"]);
console.log("ical : tous les tests passent");
