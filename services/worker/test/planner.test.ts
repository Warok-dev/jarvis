import assert from "node:assert/strict";
import {
  DEFAULT_PREFERENCES as P, dayKey, estimateMinutes, freeIntervals, plan, remainingMinutes, torontoTime,
} from "../src/planner/planner.ts";

const H = 3_600_000;
const fmt = new Intl.DateTimeFormat("fr-CA", { timeZone: "America/Toronto", weekday: "short", hour: "2-digit", minute: "2-digit" });
const show = (d: Date) => fmt.format(d);

// Fuseau : 18 h à Toronto = 22 h UTC en été, 23 h UTC en hiver (changement d'heure le 1er novembre).
assert.equal(torontoTime(2026, 10, 5, 18, 0).toISOString(), "2026-10-05T22:00:00.000Z");
assert.equal(torontoTime(2026, 11, 2, 18, 0).toISOString(), "2026-11-02T23:00:00.000Z");

// Estimations
assert.equal(estimateMinutes("Pre-lab soudage"), 60);
assert.equal(estimateMinutes("Quiz4Particip", "quiz"), 45);
assert.equal(estimateMinutes("Livrable de projet E - Prototype 1"), 360);
assert.equal(estimateMinutes("Devoir d'économie 2"), 240);
assert.equal(estimateMinutes("Lab 3"), 180);
assert.equal(remainingMinutes(240, "in_progress"), 120);
assert.equal(remainingMinutes(240, "done"), 0);

// Lundi 5 octobre 2026, 17 h à Toronto.
const now = torontoTime(2026, 10, 5, 17, 0);

// Créneaux : lundi 18 h–22 h 30, sauf un cours 19 h–20 h.
const cours = { start: torontoTime(2026, 10, 5, 19, 0), end: torontoTime(2026, 10, 5, 20, 0) };
const free = freeIntervals(P, [cours], now, 0);
assert.deepEqual(free.map((i) => `${show(i.start)}→${show(i.end)}`), ["lun. 18 h 00→lun. 19 h 00", "lun. 20 h 00→lun. 22 h 30"]);

// Départ en cours de créneau : arrondi au quart d'heure suivant.
const midSlot = freeIntervals(P, [], torontoTime(2026, 10, 5, 18, 7), 0);
assert.equal(show(midSlot[0].start), "lun. 18 h 15");

// EDF : la tâche due mercredi passe avant celle due vendredi, même si listée après.
const tasks = [
  { id: "vendredi", dueAt: torontoTime(2026, 10, 9, 23, 59), minutes: 180 },
  { id: "mercredi", dueAt: torontoTime(2026, 10, 7, 19, 0), minutes: 120 },
];
const r = plan(tasks, [cours], P, now);
assert.equal(r.unscheduled.length, 0);
assert.equal(r.blocks[0].taskId, "mercredi");
assert.equal(show(r.blocks[0].start), "lun. 18 h 00");
// Blocs ≤ 90 min, pauses respectées, aucun chevauchement avec le cours.
for (const b of r.blocks) {
  assert.ok(b.end.getTime() - b.start.getTime() <= 90 * 60_000);
  assert.ok(b.end <= cours.start || b.start >= cours.end);
}
for (let i = 1; i < r.blocks.length; i++) assert.ok(r.blocks[i].start >= r.blocks[i - 1].end);
const total = (id: string) => r.blocks.filter((b) => b.taskId === id).reduce((n, b) => n + (b.end.getTime() - b.start.getTime()) / 60_000, 0);
assert.equal(total("mercredi"), 120);
assert.equal(total("vendredi"), 180);

// Plafond quotidien : jamais plus de 240 min planifiées le même jour.
const lourd = plan([{ id: "gros", dueAt: torontoTime(2026, 10, 12, 23, 59), minutes: 900 }], [], P, now);
const perDay = new Map<string, number>();
for (const b of lourd.blocks) perDay.set(dayKey(b.start), (perDay.get(dayKey(b.start)) ?? 0) + (b.end.getTime() - b.start.getTime()) / 60_000);
assert.ok([...perDay.values()].every((m) => m <= 240));

// Marge : rien planifié dans les 2 h avant l'échéance ; charge impossible signalée.
const serre = plan([{ id: "ce-soir", dueAt: torontoTime(2026, 10, 5, 21, 0), minutes: 120 }], [], P, now);
assert.ok(serre.blocks.every((b) => b.end <= new Date(torontoTime(2026, 10, 5, 21, 0).getTime() - 2 * H)));
assert.equal(serre.blocks.length, 1); // 18 h–19 h, seul créneau avant la limite de 19 h
assert.deepEqual(serre.unscheduled, [{ taskId: "ce-soir", missingMinutes: 60 }]);

// Échéance passée ou tâche terminée : ignorées.
assert.equal(plan([{ id: "passe", dueAt: torontoTime(2026, 10, 1, 12, 0), minutes: 60 }], [], P, now).blocks.length, 0);

// Occupations fixes hebdomadaires : un cours chaque lundi 18 h 30–20 h, deux lundis de suite.
const avecCours = { ...P, busyWeekly: [{ weekday: 1, start: "18:30", end: "20:00", label: "cours" }] };
const libres = freeIntervals(avecCours, [], now, 7).filter((i) => show(i.start).startsWith("lun."));
assert.deepEqual(libres.map((i) => `${show(i.start)}→${show(i.end)}`), [
  "lun. 18 h 00→lun. 18 h 30", "lun. 20 h 00→lun. 22 h 30", "lun. 18 h 00→lun. 18 h 30", "lun. 20 h 00→lun. 22 h 30",
]);

console.log("planner : tous les tests passent");

// Préférences hostiles bornées (aucune ne doit bloquer le calcul).
import { sanitizePreferences } from "../src/planner/run.ts";
const hostile = sanitizePreferences({
  maxBlockMinutes: 1e-9, minBlockMinutes: 0, breakMinutes: -5, dailyCapMinutes: 1e12, bufferBeforeDueMinutes: "x",
  windows: [{ weekday: 9, start: "18:00", end: "22:00" }, { weekday: 1, start: "25:00", end: "26:00" }, { weekday: 2, start: "18:00", end: "20:00" }],
  busyWeekly: Array.from({ length: 500 }, () => ({ weekday: 1, start: "08:00", end: "09:00", label: "x".repeat(100) })),
});
assert.equal(hostile.maxBlockMinutes, 15);
assert.equal(hostile.minBlockMinutes, 15);
assert.equal(hostile.breakMinutes, 0);
assert.equal(hostile.dailyCapMinutes, 960);
assert.equal(hostile.bufferBeforeDueMinutes, 120);
assert.deepEqual(hostile.windows, [{ weekday: 2, start: "18:00", end: "20:00" }]);
assert.equal(hostile.busyWeekly!.length, 100);
assert.equal(hostile.busyWeekly![0].label!.length, 40);
const t0 = Date.now();
plan([{ id: "x", dueAt: torontoTime(2026, 10, 20, 12, 0), minutes: 3000 }], [], hostile, now);
assert.ok(Date.now() - t0 < 1000, "calcul trop long avec des préférences bornées");
console.log("préférences bornées : OK");
