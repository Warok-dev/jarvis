// Authentification du PC par secret d'appareil (HMAC-SHA256) et canal temps réel privé.
// WebCrypto uniquement : tourne sous Node (tests) et Deno (Edge Functions).
// Le code Rust de l'app de bureau implémente exactement les mêmes dérivations.

import { b64urlDecode, b64urlEncode } from "../push/webpush.ts";

const enc = new TextEncoder();
const MAX_SKEW_SECONDS = 120;

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64urlDecode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(message));
  return b64urlEncode(new Uint8Array(sig));
}

// Vérification à temps constant (crypto.subtle.verify).
export async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await hmacKey(secret), b64urlDecode(signature), enc.encode(message));
  } catch {
    return false;
  }
}

// Canal temps réel du PC : dérivé du secret, donc impossible à deviner sans lui.
export async function topicFor(secret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`jarvis-topic:${secret}`)));
  return `jarvis-pc-${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface SignedRequest {
  device_id: string;
  ts: number; // secondes Unix, horloge du PC
  [key: string]: unknown;
}

// Corps brut signé par le PC : en-tête x-jarvis-signature = HMAC(secret, corps).
export function parseSignedBody(raw: string): SignedRequest | null {
  try {
    const body = JSON.parse(raw);
    if (typeof body?.device_id !== "string" || typeof body?.ts !== "number") return null;
    return body as SignedRequest;
  } catch {
    return null;
  }
}

export function isFresh(ts: number, now = Date.now()): boolean {
  return Math.abs(now / 1000 - ts) <= MAX_SKEW_SECONDS;
}

export interface PcStep {
  action: "open_app" | "open_url" | "type_text" | "press_key" | "wait" | "notify";
  [key: string]: unknown;
}

// Commande envoyée au PC : on signe la chaîne JSON exacte que le PC recevra.
export async function signCommand(
  secret: string,
  command: { id: string; steps: PcStep[]; summary: string; expires_at: string },
): Promise<{ body: string; sig: string }> {
  const body = JSON.stringify(command);
  return { body, sig: await sign(secret, `cmd:${body}`) };
}

// Diffusion vers le canal du PC via l'API REST de Realtime (clé secrète du serveur).
export async function broadcast(
  supabaseUrl: string,
  secretKey: string,
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(`${new URL(supabaseUrl).origin}/realtime/v1/api/broadcast`, {
    method: "POST",
    headers: { apikey: secretKey, "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
  });
  if (!res.ok) console.error("broadcast refusé", res.status, (await res.text()).slice(0, 200));
  return res.ok;
}
