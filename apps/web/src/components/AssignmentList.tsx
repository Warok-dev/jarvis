import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { PushSettings } from "./PushSettings";
import { Assistant } from "./Assistant";
import { currentDevice } from "../lib/device";
import { PcIndicator } from "./PcIndicator";
import { StudyPlan } from "./StudyPlan";
import { estimateMinutes, replan, setEstimate } from "../lib/plan";
import {
  fetchAssignments, formatDue, groupOf, GROUP_LABELS, setStatus, subscribeAssignments,
  type Assignment, type GroupKey, type Status,
} from "../lib/assignments";

const ORDER: GroupKey[] = ["late", "today", "week", "later", "done"];

export function AssignmentList({ userId }: { userId: string }) {
  const [items, setItems] = useState<Assignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [planVersion, setPlanVersion] = useState(0);
  // Devoir ouvert depuis une notification (?a=<id>) : on le met en évidence.
  const [focusId, setFocusId] = useState(() => new URLSearchParams(location.search).get("a"));

  const load = useCallback(() => {
    fetchAssignments().then(setItems, (e: Error) => setError(e.message));
    setNow(new Date());
  }, []);

  useEffect(() => {
    load();
    const unsubscribe = subscribeAssignments(userId, (row) =>
      setItems((list) => {
        if (!list) return list;
        const rest = list.filter((a) => a.id !== row.id);
        return row.removed_at ? rest : [...rest, row].sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""));
      }),
    );
    // iOS coupe la connexion temps réel en arrière-plan : on recharge au retour.
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tick);
    };
  }, [userId, load]);

  useEffect(() => {
    if (!focusId || !items) return;
    const target = items.find((a) => a.id === focusId);
    if (target?.status === "done") setShowDone(true);
    history.replaceState(null, "", location.pathname);
    requestAnimationFrame(() => document.getElementById(`a-${focusId}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    const t = setTimeout(() => setFocusId(null), 2500);
    return () => clearTimeout(t);
  }, [focusId, items]);

  const groups = useMemo(() => {
    const g = new Map<GroupKey, Assignment[]>(ORDER.map((k) => [k, []]));
    for (const a of items ?? []) g.get(groupOf(a, now))!.push(a);
    g.get("done")!.reverse(); // les plus récents d'abord
    return g;
  }, [items, now]);

  async function change(a: Assignment, status: Status) {
    const previous = a.status;
    setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, status } : x)) ?? list);
    try {
      await setStatus(a.id, status);
    } catch (e) {
      setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, status: previous } : x)) ?? list);
      setError(`Impossible d'enregistrer : ${(e as Error).message}`);
    }
  }

  // Durée modifiée : on enregistre, puis on recalcule le planning une fois les changements finis.
  const replanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function changeEstimate(a: Assignment, minutes: number) {
    setItems((list) => list?.map((x) => (x.id === a.id ? { ...x, estimated_minutes: minutes } : x)) ?? list);
    try {
      await setEstimate(a.id, minutes);
      if (replanTimer.current) clearTimeout(replanTimer.current);
      replanTimer.current = setTimeout(() => replan().then(() => setPlanVersion((v) => v + 1)), 1200);
    } catch (e) {
      setError(`Impossible d'enregistrer la durée : ${(e as Error).message}`);
    }
  }

  const pending = items ? items.length - groups.get("done")!.length : 0;

  return (
    <main className="home">
      <header className="topbar">
        <div>
          <h1>Devoirs</h1>
          {items && <p className="subtitle">{pending === 0 ? "Rien à faire. Profite." : `${pending} à faire`}</p>}
        </div>
        <div className="topbar-side">
          <PcIndicator />
          <button className="ghost" onClick={() => supabase.auth.signOut()}>Déconnexion</button>
        </div>
      </header>

      {/* Sur PC, les alertes passeront par des notifications Windows natives. */}
      {currentDevice() !== "desktop" && <PushSettings />}

      {items && <StudyPlan assignments={items} version={planVersion} />}

      {error && <p className="error banner" role="alert" onClick={() => setError(null)}>{error}</p>}
      {!items && !error && <p className="muted center">Chargement…</p>}

      {items && ORDER.map((key) => {
        const list = groups.get(key)!;
        if (!list.length) return null;
        const collapsed = key === "done" && !showDone;
        return (
          <section key={key} className={`group group-${key}`}>
            <h2>
              {key === "done" ? (
                <button className="group-toggle" onClick={() => setShowDone((v) => !v)} aria-expanded={showDone}>
                  {GROUP_LABELS[key]} <span className="count">{list.length}</span> <span aria-hidden="true">{showDone ? "▾" : "▸"}</span>
                </button>
              ) : (
                <>{GROUP_LABELS[key]} <span className="count">{list.length}</span></>
              )}
            </h2>
            {!collapsed && (
              <ul>
                {list.map((a) => <Row key={a.id} a={a} now={now} focused={a.id === focusId} onChange={change} onEstimate={changeEstimate} />)}
              </ul>
            )}
          </section>
        );
      })}

      <Assistant />
    </main>
  );
}

const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 300, 360, 480, 600, 900];
const durationLabel = (m: number) => (m < 60 ? `${m} min` : `${m / 60} h`.replace(".", ","));

function Row({ a, now, focused, onChange, onEstimate }: {
  a: Assignment; now: Date; focused: boolean;
  onChange: (a: Assignment, s: Status) => void; onEstimate: (a: Assignment, minutes: number) => void;
}) {
  const estimate = a.estimated_minutes ?? estimateMinutes(a.title, a.item_type);
  const { date, relative } = formatDue(a.due_at, now);
  const done = a.status === "done";
  return (
    <li id={`a-${a.id}`} className={`row status-${a.status}${focused ? " focused" : ""}`}>
      <button
        className="check"
        role="checkbox"
        aria-checked={done}
        aria-label={done ? `Remettre « ${a.title} » à faire` : `Marquer « ${a.title} » comme terminé`}
        onClick={() => onChange(a, done ? "todo" : "done")}
      />
      <div className="row-body">
        <p className="row-title">{a.title}</p>
        <p className="row-meta">
          <span className="course">{a.course_code ?? "—"}</span>
          {a.item_type === "quiz" && <span className="tag">quiz</span>}
          <span>{date}</span>
          {!done && relative && <span className="relative">{relative}</span>}
          {!done && (
            <select
              className="duration"
              value={DURATIONS.includes(estimate) ? estimate : ""}
              onChange={(e) => onEstimate(a, Number(e.target.value))}
              aria-label={`Durée estimée de « ${a.title} »`}
              title="Durée estimée (sert au planning)"
            >
              {!DURATIONS.includes(estimate) && <option value="">≈ {durationLabel(estimate)}</option>}
              {DURATIONS.map((m) => <option key={m} value={m}>≈ {durationLabel(m)}</option>)}
            </select>
          )}
        </p>
      </div>
      {!done && (
        <button
          className={`chip ${a.status === "in_progress" ? "on" : ""}`}
          aria-pressed={a.status === "in_progress"}
          onClick={() => onChange(a, a.status === "in_progress" ? "todo" : "in_progress")}
        >
          En cours
        </button>
      )}
    </li>
  );
}
