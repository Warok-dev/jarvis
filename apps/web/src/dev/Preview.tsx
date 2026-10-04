// Aperçu visuel sans connexion, en développement uniquement : http://localhost:5180/#preview
import { Assistant } from "../components/Assistant";

export function Preview() {
  return (
    <main className="home">
      <header className="topbar"><div><h1>Devoirs</h1><p className="subtitle">Aperçu (développement)</p></div></header>
      <section className="push-card"><div className="push-row">
        <p><strong>Activer les notifications</strong><br /><span className="muted">Jarvis te prévient des nouveaux devoirs et des échéances.</span></p>
        <button className="primary">Activer</button>
      </div></section>
      <section className="group group-week"><h2>7 prochains jours <span className="count">2</span></h2><ul>
        <li className="row status-todo"><button className="check" role="checkbox" aria-checked="false" /><div className="row-body"><p className="row-title">Soumission de lab soudage</p><p className="row-meta"><span className="course">GNG2501B</span><span>lun. 5 oct. · 19 h 00</span><span className="relative">dans 2 j</span></p></div><button className="chip">En cours</button></li>
        <li className="row status-in_progress"><button className="check" role="checkbox" aria-checked="false" /><div className="row-body"><p className="row-title">Devoir 1</p><p className="row-meta"><span className="course">CEG3555</span><span>lun. 5 oct. · 20 h 00</span><span className="relative">dans 2 j</span></p></div><button className="chip on">En cours</button></li>
      </ul></section>
      <Assistant />
    </main>
  );
}
