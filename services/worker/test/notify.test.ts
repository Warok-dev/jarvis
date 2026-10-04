import assert from "node:assert/strict";
import { isQuietHour, planNotifications, toMessages, type PendingEvent } from "../src/notify/notify.ts";

const now = new Date("2026-10-05T14:00:00Z"); // 10 h à Toronto
const H = 3600e3;
const a = (id: string, dueInH: number, extra = {}) => ({
  id, title: `Devoir ${id}`, course_code: "CEG3555", due_at: new Date(now.getTime() + dueInH * H).toISOString(),
  status: "todo", removed_at: null, ...extra,
});

// Heures calmes (heure de Toronto)
assert.equal(isQuietHour(new Date("2026-10-05T14:00:00Z")), false); // 10 h
assert.equal(isQuietHour(new Date("2026-10-06T03:30:00Z")), true);  // 23 h 30
assert.equal(isQuietHour(new Date("2026-10-05T11:59:00Z")), true);  // 7 h 59
assert.equal(isQuietHour(new Date("2026-10-05T12:00:00Z")), false); // 8 h

// 1. Nouveaux devoirs : passé ignoré, terminé ignoré, futurs notifiés et regroupés
const events: PendingEvent[] = [
  { id: 1, type: "created", payload: {}, assignment: a("passe", -5) },
  { id: 2, type: "created", payload: {}, assignment: a("fini", 50, { status: "done" }) },
  { id: 3, type: "created", payload: {}, assignment: a("x", 100) },
  { id: 4, type: "created", payload: {}, assignment: a("y", 200) },
  { id: 5, type: "due_changed", payload: { from: now.toISOString() }, assignment: a("z", 72) },
];
let rows = planNotifications("u", events, [], new Set(), now);
assert.deepEqual(rows.map((r) => `${r.dedup_key}=${r.kind}`), [
  "event:1=skipped", "event:2=skipped", "event:3=new_assignment", "event:4=new_assignment", "event:5=due_changed",
]);
const msgs = toMessages(rows);
assert.equal(msgs.length, 2);
assert.equal(msgs[0].message.title, "2 nouveaux devoirs");
assert.deepEqual(msgs[0].ids, ["event:3", "event:4"]);
assert.match(msgs[1].message.title, /^Échéance modifiée/);

// 2. Rappels : 20 h → 24 h ; 2 h → 3 h (et 24 h marqué ignoré) ; 30 h → rien
const upcoming = [a("r20", 20), a("r2", 2), a("r30", 30), a("enCours", 1, { status: "in_progress" })];
rows = planNotifications("u", [], upcoming, new Set(), now);
assert.deepEqual(rows.map((r) => r.kind), ["reminder_24h", "skipped", "reminder_3h", "skipped", "reminder_3h"]);
assert.match(rows[0].title!, /^À rendre dans 20 h/);
assert.match(rows[4].body!, /En cours/);

// 3. Déduplication : rien de neuf au deuxième passage
const seen = new Set(rows.map((r) => r.dedup_key));
assert.equal(planNotifications("u", [], upcoming, seen, now).length, 0);

// 4. Un report d'échéance donne une nouvelle clé de rappel
const moved = [{ ...upcoming[0], due_at: new Date(now.getTime() + 22 * H).toISOString() }];
assert.equal(planNotifications("u", [], moved, seen, now).length, 1);

console.log("notify : tous les tests passent");
