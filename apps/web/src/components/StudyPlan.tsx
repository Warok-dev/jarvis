import { useCallback, useEffect, useMemo, useState } from "react";
import type { Assignment } from "../lib/assignments";
import { fetchPlan, replan, type PlanData } from "../lib/plan";

const TZ = "America/Toronto";
const dayFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const keyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

function dayLabel(d: Date, now: Date): string {
  const k = keyFmt.format(d);
  if (k === keyFmt.format(now)) return "Aujourd'hui";
  if (k === keyFmt.format(new Date(now.getTime() + 864e5))) return "Demain";
  const s = dayFmt.format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const hours = (min: number) => (min >= 60 ? `${Math.round((min / 60) * 2) / 2} h` : `${min} min`);

// Planning de révision proposé par Jarvis (recalculé chaque matin, ou à la demande).
export function StudyPlan({ assignments, initial }: { assignments: Assignment[]; initial?: PlanData }) {
  const [plan, setPlan] = useState<PlanData | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => fetchPlan().then(setPlan, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    if (!initial) void load();
  }, [load, initial]);

  const byId = useMemo(() => new Map(assignments.map((a) => [a.id, a])), [assignments]);
  const now = new Date();

  async function recompute() {
    setBusy(true);
    setError(null);
    try {
      await replan();
      await load();
    } catch (e) {
      setError(`Recalcul impossible : ${(e as Error).message}`);
    }
    setBusy(false);
  }

  if (!plan) return null;
  // Les blocs de devoirs terminés depuis le dernier calcul disparaissent tout de suite.
  const blocks = plan.blocks.filter((b) => byId.get(b.assignment_id) && byId.get(b.assignment_id)!.status !== "done");
  const shown = expanded ? blocks : blocks.slice(0, 6);
  const missing = plan.unscheduled.filter((u) => byId.get(u.taskId) && byId.get(u.taskId)!.status !== "done");

  let lastDay = "";
  return (
    <section className="plan">
      <div className="plan-head">
        <h2>Planning</h2>
        <button className="ghost" onClick={recompute} disabled={busy}>{busy ? "Calcul…" : "Recalculer"}</button>
      </div>

      {missing.length > 0 && (
        <div className="plan-warning" role="status">
          <strong>Pas assez de temps avant l'échéance</strong>
          {missing.map((u) => {
            const a = byId.get(u.taskId)!;
            return <p key={u.taskId}>{a.course_code} {a.title} — il manque environ {hours(u.missingMinutes)}</p>;
          })}
        </div>
      )}

      {!blocks.length ? (
        <p className="muted plan-empty">Rien à planifier pour l'instant.</p>
      ) : (
        <ol className="plan-list">
          {shown.map((b) => {
            const a = byId.get(b.assignment_id)!;
            const start = new Date(b.starts_at);
            const day = dayLabel(start, now);
            const header = day !== lastDay ? <li key={`jour-${b.id}`} className="plan-day">{day}</li> : null;
            lastDay = day;
            const current = start <= now && new Date(b.ends_at) > now;
            return [
              header,
              <li key={b.id} className={`plan-block${current ? " now" : ""}`}>
                <span className="plan-time">{timeFmt.format(start)} – {timeFmt.format(new Date(b.ends_at))}</span>
                <span className="plan-what"><span className="course">{a.course_code ?? "—"}</span> {a.title}</span>
              </li>,
            ];
          })}
        </ol>
      )}
      {blocks.length > 6 && (
        <button className="ghost plan-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Voir moins" : `Voir les ${blocks.length - 6} autres blocs`}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
