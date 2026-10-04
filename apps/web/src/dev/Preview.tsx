// Aperçu visuel sans connexion, en développement uniquement : http://localhost:5180/#preview
import { Assistant } from "../components/Assistant";
import { StudyPlan } from "../components/StudyPlan";
import type { Assignment } from "../lib/assignments";

const h = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString();
const sample: Assignment[] = [
  { id: "a", course_code: "GNG2501B", title: "Soumission de lab soudage", item_type: "item", due_at: h(40), status: "todo", url: null, removed_at: null },
  { id: "b", course_code: "CEG3555", title: "Devoir 1", item_type: "item", due_at: h(41), status: "in_progress", url: null, removed_at: null },
];
const samplePlan = {
  computedAt: h(0),
  unscheduled: [{ taskId: "b", missingMinutes: 180 }],
  blocks: [
    { id: 1, assignment_id: "a", starts_at: h(-0.5), ends_at: h(1) },
    { id: 2, assignment_id: "b", starts_at: h(1.25), ends_at: h(2.25) },
    { id: 3, assignment_id: "a", starts_at: h(24), ends_at: h(25.5) },
  ],
};

export function Preview() {
  return (
    <main className="home">
      <header className="topbar"><div><h1>Devoirs</h1><p className="subtitle">Aperçu (développement)</p></div></header>
      <section className="push-card"><div className="push-row">
        <p><strong>Activer les notifications</strong><br /><span className="muted">Jarvis te prévient des nouveaux devoirs et des échéances.</span></p>
        <button className="primary">Activer</button>
      </div></section>
      <StudyPlan assignments={sample} initial={samplePlan} />
      <section className="group group-week"><h2>7 prochains jours <span className="count">2</span></h2><ul>
        <li className="row status-todo"><button className="check" role="checkbox" aria-checked="false" /><div className="row-body"><p className="row-title">Soumission de lab soudage</p><p className="row-meta"><span className="course">GNG2501B</span><span>lun. 5 oct. · 19 h 00</span><span className="relative">dans 2 j</span></p></div><button className="chip">En cours</button></li>
        <li className="row status-in_progress"><button className="check" role="checkbox" aria-checked="false" /><div className="row-body"><p className="row-title">Devoir 1</p><p className="row-meta"><span className="course">CEG3555</span><span>lun. 5 oct. · 20 h 00</span><span className="relative">dans 2 j</span></p></div><button className="chip on">En cours</button></li>
      </ul></section>
      <Assistant />
    </main>
  );
}
