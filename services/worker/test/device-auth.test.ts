// Vecteurs fixes partagés avec les tests Rust de l'app de bureau (apps/desktop/src-tauri/src/device.rs).
import assert from "node:assert/strict";
import { isFresh, sign, signCommand, topicFor, verify } from "../src/devices/device-auth.ts";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // octets 0..31
assert.equal(await sign(SECRET, '{"device_id":"x","ts":1}'), "caBPy66khQ_qHCOAbdbVpBPP9pl4r3J8iaIqUoIcSis");
assert.equal(await sign(SECRET, 'cmd:{"id":"c"}'), "UPfyaQ7JoJYOgVJB6NLj-CDkzHgXfBZMJoMc5z68io8");
assert.equal(await topicFor(SECRET), "jarvis-pc-bd3588be36955dd3327183d229e6db9f");

assert.equal(await verify(SECRET, "abc", await sign(SECRET, "abc")), true);
assert.equal(await verify(SECRET, "abd", await sign(SECRET, "abc")), false);
assert.equal(await verify(SECRET, "abc", "pas-une-signature"), false);

const cmd = await signCommand(SECRET, { id: "c1", steps: [{ action: "open_app", app: "notepad" }], summary: "Bloc-notes", expires_at: "2026-10-04T06:00:00Z" });
assert.equal(await verify(SECRET, `cmd:${cmd.body}`, cmd.sig), true);

assert.equal(isFresh(1000, 1_050_000), true);
assert.equal(isFresh(1000, 1_200_000), false);
console.log("device-auth : tous les tests passent");
