import type { SupabaseClient } from "@supabase/supabase-js";
import type { PcAccess } from "./pc-tools.ts";
import { availableTools, contextLine, executeTool, SYSTEM, type ChatTurn } from "./assistant.ts";

// Même cerveau que Claude (consignes et outils identiques), sur l'offre gratuite de Google Gemini.
// API REST directe (generateContent) : pas de dépendance, fonctionne sous Node et Deno.

const MAX_TOOL_ROUNDS = 6;
const API = "https://generativelanguage.googleapis.com/v1beta/models";
// L'offre gratuite renvoie parfois « forte demande » (503) ou « quota » (429) : on réessaie,
// puis on se replie sur le modèle Flash-Lite, plus disponible.
const FALLBACK_MODEL = "gemini-flash-lite-latest";
const RETRY_STATUS = new Set([429, 500, 503]);
const RETRY_DELAYS_MS = [800, 2000];

type Schema = Record<string, unknown>;

// JSON Schema (format des outils Claude) → sous-ensemble OpenAPI attendu par Gemini.
export function toGeminiSchema(schema: Schema): Schema {
  const out: Schema = {};
  const type = schema.type;
  if (Array.isArray(type)) {
    const real = type.filter((t) => t !== "null");
    out.type = String(real[0] ?? "string").toUpperCase();
    if (type.includes("null")) out.nullable = true;
  } else if (typeof type === "string") {
    out.type = type.toUpperCase();
  }
  if (typeof schema.description === "string") out.description = schema.description;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v) => v !== null);
    out.enum = values.map(String);
    if (values.length !== schema.enum.length) out.nullable = true;
  }
  if (schema.properties && typeof schema.properties === "object") {
    const props = Object.entries(schema.properties as Record<string, Schema>);
    if (props.length) out.properties = Object.fromEntries(props.map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items as Schema);
  return out;
}

interface Part {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  [key: string]: unknown;
}

export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function chatGemini(
  apiKey: string,
  model: string,
  db: SupabaseClient,
  history: ChatTurn[],
  device: "mobile" | "desktop" | "web",
  pc?: PcAccess,
): Promise<{ reply: string; changed: boolean }> {
  const functionDeclarations = availableTools(pc).map((t) => {
    const params = toGeminiSchema(t.input_schema as Schema);
    return { name: t.name, description: t.description, ...(params.properties ? { parameters: params } : {}) };
  });
  const contents: Array<{ role: string; parts: Part[] }> = history.map((t) => ({
    role: t.role === "assistant" ? "model" : "user",
    parts: [{ text: t.content }],
  }));
  let changed = false;

  const generate = async () => {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: `${SYSTEM}\n${contextLine(device)}` }] },
      contents,
      tools: [{ functionDeclarations }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    });
    let last: GeminiError | null = null;
    for (const m of model === FALLBACK_MODEL ? [model] : [model, FALLBACK_MODEL]) {
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        const res = await fetch(`${API}/${m}:generateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body,
        });
        const json = await res.json().catch(() => null);
        if (res.ok) return json;
        last = new GeminiError(res.status, json?.error?.message ?? `HTTP ${res.status}`);
        if (!RETRY_STATUS.has(res.status)) throw last;
        if (attempt < RETRY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
    throw last!;
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const json = await generate();

    const candidate = json?.candidates?.[0];
    const parts: Part[] = candidate?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join(" ").trim();
      if (!text && candidate?.finishReason === "SAFETY") return { reply: "Je ne peux pas t'aider avec ça.", changed };
      return { reply: text || "D'accord.", changed };
    }

    // Le tour du modèle est renvoyé tel quel (il peut contenir des signatures de raisonnement).
    contents.push({ role: "model", parts });
    const responses = await Promise.all(calls.map(async ({ functionCall }) => {
      const { name, args = {}, id } = functionCall!;
      let result: string;
      try {
        result = await executeTool(db, name, args, device, pc);
        if (name === "update_assignment_status") changed = true;
      } catch (e) {
        result = `Erreur : ${(e as Error).message}`;
      }
      return { functionResponse: { name, ...(id ? { id } : {}), response: { result } } };
    }));
    contents.push({ role: "user", parts: responses });
  }
  return { reply: "Je n'ai pas réussi à finir, peux-tu reformuler ?", changed };
}
