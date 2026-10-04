import { useEffect, useState } from "react";
import { fetchPreferences, replan, savePreferences, type Preferences, type WeeklyBusy } from "../lib/plan";

// Lundi d'abord, comme dans un agenda.
const DAYS = [
  [1, "Lundi"], [2, "Mardi"], [3, "Mercredi"], [4, "Jeudi"], [5, "Vendredi"], [6, "Samedi"], [0, "Dimanche"],
] as const;
// Abréviation à l’écran (place limitée sur téléphone), nom complet pour les lecteurs d’écran.
const short = (label: string) => label.slice(0, 3);
const CAPS = [120, 180, 240, 300, 360, 480];

type DayRow = { on: boolean; start: string; end: string };

// Disponibilités (une plage par jour) et plafond quotidien du planificateur.
export function PlanSettings({ onSaved }: { onSaved: () => void }) {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [rows, setRows] = useState<Record<number, DayRow>>({});
  const [busyWeekly, setBusyWeekly] = useState<WeeklyBusy[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPreferences().then((p) => {
      setPrefs(p);
      setBusyWeekly(p.busyWeekly ?? []);
      const r: Record<number, DayRow> = {};
      for (const [d] of DAYS) {
        const w = p.windows.find((x) => x.weekday === d);
        r[d] = w ? { on: true, start: w.start, end: w.end } : { on: false, start: "18:00", end: "22:00" };
      }
      setRows(r);
    });
  }, []);

  if (!prefs) return null;
  const update = (d: number, patch: Partial<DayRow>) => setRows((r) => ({ ...r, [d]: { ...r[d], ...patch } }));
  const invalid = DAYS.some(([d]) => rows[d].on && rows[d].end <= rows[d].start) || busyWeekly.some((b) => b.end <= b.start);
  const updateBusy = (i: number, patch: Partial<WeeklyBusy>) =>
    setBusyWeekly((list) => list.map((b, j) => (j === i ? { ...b, ...patch } : b)));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const windows = DAYS.filter(([d]) => rows[d].on).map(([d]) => ({ weekday: d, start: rows[d].start, end: rows[d].end }));
      await savePreferences({ ...prefs!, windows, busyWeekly });
      await replan();
      onSaved();
    } catch (e) {
      setError(`Enregistrement impossible : ${(e as Error).message}`);
    }
    setBusy(false);
  }

  return (
    <div className="plan-settings">
      <p className="muted">Quand Jarvis peut-il te faire travailler ?</p>
      {DAYS.map(([d, label]) => (
        <div key={d} className={`plan-day-row${rows[d].on ? "" : " off"}`}>
          <label className="plan-day-name">
            <input type="checkbox" checked={rows[d].on} aria-label={label} onChange={(e) => update(d, { on: e.target.checked })} />
            <span aria-hidden="true">{short(label)}</span>
          </label>
          <input
            type="time" step={900} value={rows[d].start} disabled={!rows[d].on} aria-label={`${label}, début`}
            onChange={(e) => update(d, { start: e.target.value })}
          />
          <span aria-hidden="true">–</span>
          <input
            type="time" step={900} value={rows[d].end} disabled={!rows[d].on} aria-label={`${label}, fin`}
            onChange={(e) => update(d, { end: e.target.value })}
          />
        </div>
      ))}
      <p className="muted plan-subtitle">Cours et engagements fixes (jamais de révision pendant)</p>
      {busyWeekly.map((b, i) => (
        <div key={i} className="plan-busy-row">
          <select value={b.weekday} onChange={(e) => updateBusy(i, { weekday: Number(e.target.value) })} aria-label="Jour">
            {DAYS.map(([d, label]) => <option key={d} value={d}>{short(label)}</option>)}
          </select>
          <input type="time" step={900} value={b.start} aria-label="Début" onChange={(e) => updateBusy(i, { start: e.target.value })} />
          <input type="time" step={900} value={b.end} aria-label="Fin" onChange={(e) => updateBusy(i, { end: e.target.value })} />
          <button className="ghost" aria-label="Retirer" onClick={() => setBusyWeekly((l) => l.filter((_, j) => j !== i))}>✕</button>
          <input className="plan-busy-label" value={b.label ?? ""} placeholder="Nom (ex. cours CEG3555)" aria-label="Nom"
            onChange={(e) => updateBusy(i, { label: e.target.value.slice(0, 40) })} />
        </div>
      ))}
      <button className="ghost plan-add" onClick={() => setBusyWeekly((l) => [...l, { weekday: 1, start: "08:30", end: "10:00", label: "" }])}>
        + Ajouter un cours ou un engagement
      </button>
      <label className="plan-cap">
        Maximum par jour
        <select value={prefs.dailyCapMinutes} onChange={(e) => setPrefs({ ...prefs, dailyCapMinutes: Number(e.target.value) })}>
          {CAPS.map((c) => <option key={c} value={c}>{c / 60} h</option>)}
        </select>
      </label>
      {invalid && <p className="error">Une plage se termine avant de commencer.</p>}
      {error && <p className="error">{error}</p>}
      <button className="primary" onClick={save} disabled={busy || invalid}>
        {busy ? "Enregistrement…" : "Enregistrer et recalculer"}
      </button>
    </div>
  );
}
