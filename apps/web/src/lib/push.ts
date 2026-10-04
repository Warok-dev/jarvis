import { supabase } from "./supabase";

export type PushState =
  | "unsupported" // navigateur sans Web Push
  | "needs-install" // iPhone : il faut ouvrir l'app depuis l'écran d'accueil
  | "denied" // refusé dans les réglages
  | "off" // possible mais pas encore activé
  | "on";

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register("/sw.js");
}

export async function getPushState(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return "needs-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const sub = await (await registration()).pushManager.getSubscription();
  return sub ? "on" : "off";
}

async function save(sub: PushSubscription): Promise<void> {
  const json = sub.toJSON();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Session expirée");
  const { error } = await supabase.from("push_subscriptions").upsert(
    {
      user_id: user.id,
      endpoint: sub.endpoint,
      p256dh: json.keys!.p256dh,
      auth: json.keys!.auth,
      device_label: isIOS() ? "iPhone" : navigator.platform || "navigateur",
    },
    { onConflict: "endpoint", ignoreDuplicates: true },
  );
  if (error) throw error;
}

// Doit être appelé depuis un geste de l'utilisateur (exigence d'iOS).
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBytes(import.meta.env.VITE_VAPID_PUBLIC_KEY),
    }));
  await save(sub);
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub) {
    await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
    await sub.unsubscribe();
  }
  return "off";
}

// Au démarrage : si le navigateur a renouvelé l'abonnement, on le réenregistre.
export async function resyncPush(): Promise<void> {
  if ((await getPushState()) !== "on") return;
  const sub = await (await registration()).pushManager.getSubscription();
  if (sub) await save(sub);
}

export async function sendTestPush(): Promise<string> {
  const { data, error } = await supabase.functions.invoke("push-test");
  if (error) throw error;
  return (data as { message: string }).message;
}
