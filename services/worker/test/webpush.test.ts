// Vérifie le chiffrement Web Push contre le vecteur de test du RFC 8291 (annexe A).
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys } from "../src/push/webpush.ts";
import assert from "node:assert/strict";

const asPublic = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const asPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const pub = b64urlDecode(asPublic);
const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)), ext: true };
const serverKeys = {
  publicKey: await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, true, []),
  privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: asPrivate }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]),
} as CryptoKeyPair;

const out = await encryptPayload(
  new TextEncoder().encode("When I grow up, I want to be a watermelon"),
  {
    p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
  },
  { serverKeys, salt: b64urlDecode("DGv6ra1nlYgDCS1FRnbzlw") },
);

assert.equal(
  b64urlEncode(out),
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
);
console.log("RFC 8291 annexe A : OK");

const v = await generateVapidKeys();
assert.equal(b64urlDecode(v.publicKey).length, 65);
assert.equal(b64urlDecode(v.privateKey).length, 32);
console.log("Génération VAPID : OK");

// Signature VAPID : on intercepte la requête et on vérifie le JWT avec la clé publique.
import { sendPush } from "../src/push/webpush.ts";
let captured: { url: string; headers: Record<string, string> } | null = null;
globalThis.fetch = (async (url: string, init: RequestInit) => {
  captured = { url, headers: init.headers as Record<string, string> };
  return new Response("", { status: 201 });
}) as typeof fetch;
const res = await sendPush(
  { endpoint: "https://web.push.apple.com/QGz_abc", p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
  { title: "t" }, { ...v, subject: "https://jarvis-4s2.pages.dev" },
);
assert.equal(res.ok, true);
const auth = captured!.headers.Authorization;
const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/)!;
assert.equal(k, v.publicKey);
const [h, c, s] = jwt.split(".");
const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(c)));
assert.equal(claims.aud, "https://web.push.apple.com");
assert.equal(claims.sub, "https://jarvis-4s2.pages.dev");
const vk = await crypto.subtle.importKey("raw", b64urlDecode(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vk, b64urlDecode(s), new TextEncoder().encode(`${h}.${c}`)), true);
assert.equal(captured!.headers["Content-Encoding"], "aes128gcm");
console.log("Signature VAPID : OK");
