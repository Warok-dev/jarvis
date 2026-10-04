// Sur quel appareil tourne l'interface : sert au journal (« qui a changé quoi ») et à l'assistant.
export type Device = "desktop" | "mobile" | "web";

export function currentDevice(): Device {
  if ("__TAURI_INTERNALS__" in window) return "desktop"; // app de bureau (Tauri)
  if (window.matchMedia("(display-mode: standalone)").matches) return "mobile"; // app installée sur l'écran d'accueil
  return "web";
}
