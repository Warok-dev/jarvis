import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { currentDevice } from "./device";

// Dans l'app de bureau : associe ce PC au compte, une fois par session.
// Le PC reçoit ensuite son propre secret et ne dépend plus de la session de la fenêtre.
let registeredFor: string | null = null;

export async function registerDesktop(session: Session): Promise<void> {
  if (currentDevice() !== "desktop" || registeredFor === session.user.id) return;
  registeredFor = session.user.id;
  try {
    await invoke("register_device", { accessToken: session.access_token });
  } catch (e) {
    registeredFor = null;
    console.error("Association du PC impossible :", e);
  }
}

export interface PcState {
  label: string | null;
  online: boolean;
  remoteEnabled: boolean;
}

// État du PC pour l'indicateur (en ligne si battement de moins de 3 minutes).
export async function fetchPcState(): Promise<PcState | null> {
  const { data, error } = await supabase
    .from("devices")
    .select("label, last_seen_at, remote_enabled")
    .eq("kind", "desktop")
    .order("last_seen_at", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error || !data.length) return null;
  const d = data[0];
  const online = Boolean(d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < 3 * 60_000);
  return { label: d.label, online, remoteEnabled: d.remote_enabled };
}

// « Hey Jarvis » détecté par l'app de bureau alors que la fenêtre était déjà ouverte.
export function onDesktopWake(handler: () => void): () => void {
  if (currentDevice() !== "desktop") return () => {};
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  listen("jarvis-wake", handler).then((u) => (cancelled ? u() : (unlisten = u)));
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
