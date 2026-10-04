import { useEffect, useState } from "react";
import { fetchPcState, type PcState } from "../lib/desktop";

// « PC allumé / éteint » : les fonctions qui dépendent du PC ne marchent que s'il est en ligne.
export function PcIndicator() {
  const [pc, setPc] = useState<PcState | null>(null);

  useEffect(() => {
    const refresh = () => document.visibilityState === "visible" && fetchPcState().then(setPc);
    refresh();
    const timer = setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (!pc) return null; // aucun PC associé pour l'instant
  const title = pc.online
    ? `${pc.label ?? "PC"} en ligne${pc.remoteEnabled ? " — commandes à distance autorisées" : " — commandes à distance désactivées"}`
    : `${pc.label ?? "PC"} éteint ou hors ligne`;
  return (
    <span className={`pc-indicator ${pc.online ? "on" : "off"}`} title={title} aria-label={title}>
      <span className="dot" aria-hidden="true" />
      PC
    </span>
  );
}
