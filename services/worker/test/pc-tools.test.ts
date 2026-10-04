// Validation serveur des étapes envoyées au PC (avant signature).
import assert from "node:assert/strict";
import { cleanSteps } from "../src/assistant/pc-tools.ts";

const apps = [{ id: "chatgpt" }, { id: "vscode" }];
const ok = cleanSteps([
  { action: "open_app", app: "chatgpt", url: null, text: null, key: null, ms: null },
  { action: "wait", ms: 3000 },
  { action: "type_text", text: "Voici l'énoncé…" },
  { action: "press_key", key: "enter" },
], apps);
assert.deepEqual(ok.map((s) => s.action), ["open_app", "wait", "type_text", "press_key"]);
assert.deepEqual(ok[0], { action: "open_app", app: "chatgpt" }); // champs nuls retirés

const refuse = (steps: unknown[], why: RegExp) => assert.throws(() => cleanSteps(steps, apps), why);
refuse([{ action: "open_app", app: "cmd" }], /App inconnue/);
refuse([{ action: "open_url", url: "http://exemple.com" }], /URL refusée/);
refuse([{ action: "open_url", url: "javascript:alert(1)" }], /URL refusée/);
refuse([{ action: "open_url", url: "file:///C:/Windows" }], /URL refusée/);
refuse([{ action: "open_url", url: "https://a.com,C:\Windows\System32\calc.exe" }], /URL (refusée|invalide)/);
refuse([{ action: "open_url", url: "https://user:pass@a.com/" }], /URL refusée/);
refuse([{ action: "type_text", text: "rm -rf" }], /aucune app ouverte/);
refuse([{ action: "open_app", app: "vscode" }, { action: "press_key", key: "alt+f4" }], /Touche/);
refuse([{ action: "open_app", app: "vscode" }, { action: "type_text", text: "x".repeat(4001) }], /trop long/);
refuse([{ action: "wait", ms: 10000 }, { action: "wait", ms: 10000 }], /Attente totale/);
refuse([{ action: "run_shell", cmd: "del" }], /Action inconnue/);
refuse([], /vide/);
console.log("pc-tools : tous les tests passent");
