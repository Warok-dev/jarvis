import { useEffect, useState } from "react";
import { disablePush, enablePush, getPushState, resyncPush, sendTestPush, type PushState } from "../lib/push";

const HINTS: Partial<Record<PushState, string>> = {
  "needs-install": "Pour recevoir les notifications sur iPhone : bouton Partager → « Sur l'écran d'accueil », puis ouvre Jarvis depuis son icône.",
  denied: "Notifications bloquées. Réactive-les dans Réglages → Notifications → Jarvis.",
  unsupported: "Ce navigateur ne gère pas les notifications push.",
};

export function PushSettings() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    getPushState().then(setState);
    resyncPush().catch(() => {});
  }, []);

  async function run(action: () => Promise<PushState | string>) {
    setBusy(true);
    setInfo(null);
    try {
      const r = await action();
      if (r === "on" || r === "off" || r === "denied") setState(r);
      else setInfo(r);
    } catch (e) {
      setInfo(`Erreur : ${(e as Error).message}`);
    }
    setBusy(false);
  }

  if (!state) return null;

  return (
    <section className="push-card" aria-live="polite">
      {state === "on" ? (
        <div className="push-row">
          <p><strong>Notifications activées</strong><br /><span className="muted">Nouveaux devoirs, reports, rappels la veille et 3 h avant.</span></p>
          <div className="push-actions">
            <button className="chip" disabled={busy} onClick={() => run(sendTestPush)}>Tester</button>
            <button className="ghost" disabled={busy} onClick={() => run(disablePush)}>Désactiver</button>
          </div>
        </div>
      ) : state === "off" ? (
        <div className="push-row">
          <p><strong>Activer les notifications</strong><br /><span className="muted">Jarvis te prévient des nouveaux devoirs et des échéances.</span></p>
          <button className="primary" disabled={busy} onClick={() => run(enablePush)}>Activer</button>
        </div>
      ) : (
        <p className="muted">{HINTS[state]}</p>
      )}
      {info && <p className="push-info">{info}</p>}
    </section>
  );
}
