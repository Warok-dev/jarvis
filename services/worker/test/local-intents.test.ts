import assert from "node:assert/strict";
import { matchApp, matchAssignment, parseIntent, spokenTime } from "../src/assistant/local-intents.ts";

// Reconnaissance des intentions
assert.deepEqual(parseIntent("Qu'est-ce que j'ai à rendre demain ?"), { kind: "upcoming", days: 1, label: "demain" });
assert.deepEqual(parseIntent("j'ai quoi à faire cette semaine"), { kind: "upcoming", days: 7, label: "cette semaine" });
assert.deepEqual(parseIntent("Mes échéances aujourd'hui"), { kind: "upcoming", days: 0, label: "aujourd'hui" });
assert.deepEqual(parseIntent("C'est quoi mon planning ?"), { kind: "plan" });
assert.deepEqual(parseIntent("je travaille sur quoi ce soir"), { kind: "plan" });
assert.deepEqual(parseIntent("J'ai fini le lab 1 d'ELG"), { kind: "status", status: "done", query: "le lab 1 d elg" });
assert.deepEqual(parseIntent("c'est bon j'ai rendu le devoir 1 de CEG"), { kind: "status", status: "done", query: "le devoir 1 de ceg" });
assert.deepEqual(parseIntent("Je commence le devoir d'économie 2"), { kind: "status", status: "in_progress", query: "le devoir d economie 2" });
assert.deepEqual(parseIntent("Ouvre VS Code"), { kind: "open_app", app: "vs code" });
assert.deepEqual(parseIntent("Jarvis, lance chrome"), { kind: "open_app", app: "chrome" });
// Demandes complexes → modèle
assert.equal(parseIntent("Donne le devoir 2 à ChatGPT"), null);
assert.equal(parseIntent("Ouvre ChatGPT et tape l'énoncé du devoir 2"), null);
assert.equal(parseIntent("Pourquoi le planning ne met rien ce soir ?"), null);
assert.equal(parseIntent("Bonjour Jarvis"), null);

// Retrouver un devoir sans ambiguïté
const list = [
  { id: "elg1", title: "Lab 1", course_code: "ELG3525" },
  { id: "elg2", title: "Lab 2", course_code: "ELG3525" },
  { id: "ceg1", title: "Devoir 1", course_code: "CEG3555" },
  { id: "eco1", title: "Devoir d'économie 1", course_code: "GNG2501B" },
  { id: "eco2", title: "Devoir d'économie 2", course_code: "GNG2501B" },
  { id: "soud", title: "Soumission de lab soudage", course_code: "GNG2501B" },
];
assert.equal(matchAssignment("le lab 1 d elg", list)?.id, "elg1");
assert.equal(matchAssignment("le devoir 1 de ceg", list)?.id, "ceg1");
assert.equal(matchAssignment("le devoir d economie 2", list)?.id, "eco2");
assert.equal(matchAssignment("le lab de soudage", list)?.id, "soud");
assert.equal(matchAssignment("le devoir 1", list), null); // Devoir 1 ou Devoir d'économie 1 ?
assert.equal(matchAssignment("le lab", list), null);
assert.equal(matchAssignment("le projet final", list), null);

// Applications
const apps = [{ id: "vscode", label: "Visual Studio Code" }, { id: "chrome", label: "Google Chrome" }, { id: "chatgpt", label: "ChatGPT (GPT-6 Astra)" }, { id: "calculatrice", label: "Calculatrice" }];
assert.equal(matchApp("vs code", apps)?.id, "vscode");
assert.equal(matchApp("visual studio", apps)?.id, "vscode");
assert.equal(matchApp("chatgpt", apps)?.id, "chatgpt");
assert.equal(matchApp("calc", apps)?.id, "calculatrice");
assert.equal(matchApp("spotify", apps), null);

// Heures à l'oral
const at = (iso: string) => spokenTime(new Date(iso));
assert.equal(at("2026-10-05T23:00:00Z"), "à 19 h");
assert.equal(at("2026-10-06T00:30:00Z"), "à 20 h 30");
assert.equal(at("2026-10-06T03:59:59Z"), "avant minuit");

console.log("local-intents : tous les tests passent");
