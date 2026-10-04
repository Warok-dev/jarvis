import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabase";
import { PushSettings } from "./PushSettings";
import { Assistant } from "./Assistant";
import { currentDevice } from "../lib/device";
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

  const pending = items ? items.length - groups.get("done")!.length : 0;

  return (
    <main className="home">
      <header className="topbar">
        <div>
          <h1>Devoirs</h1>
          {items && <p className="subtitle">{pending === 0 ? "Rien à faire. Profite." : `${pending} à faire`}</p>}
        </div>
        <button className="ghost" onClick={() => supabase.auth.signOut()}>Déconnexion</button>
      </header>

      {/* Sur PC, les alertes passeront par des notifications Windows natives. */}
      {currentDevice() !== "desktop" && <PushSettings />}

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
                {list.map((a) => <Row key={a.id} a={a} now={now} focused={a.id === focusId} onChange={change} />)}
              </ul>
            )}
          </section>
        );
      })}

      <Assistant />
    </main>
  );
}

function Row({ a, now, focused, onChange }: {
  a: Assignment; now: Date; focused: boolean; onChange: (a: Assignment, s: Status) => void;
}) {
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
