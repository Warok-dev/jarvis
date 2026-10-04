// Conversation avec Jarvis (texte ou voix transcrite) depuis l'app web/mobile et, plus tard, le PC.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { chat, type ChatTurn } from "../../../services/worker/src/assistant/assistant.ts";

const ALLOWED_ORIGINS = ["https://jarvis-4s2.pages.dev", "http://localhost:5180"];
const MAX_TURNS = 20;
const MAX_CHARS = 2000;

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const cors = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ reply: "Mon cerveau n'est pas encore branché : il manque la clé API Anthropic côté serveur." }, 503);

  // Client à la session de l'utilisateur : RLS s'applique à chaque outil.
  const authorization = req.headers.get("authorization") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("JARVIS_PUBLISHABLE_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await db.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
  if (!user) return json({ reply: "Session expirée, reconnecte-toi." }, 401);

  let body: { messages?: ChatTurn[]; device?: string };
  try {
    body = await req.json();
  } catch {
    return json({ reply: "Requête invalide." }, 400);
  }
  const history = (body.messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") return json({ reply: "Je n'ai rien entendu." }, 400);

  const device = body.device === "mobile" || body.device === "desktop" ? body.device : "web";
  try {
    const result = await chat(new Anthropic({ apiKey }), db, history, device);
    return json(result);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ reply: "Je suis un peu débordé, réessaie dans une minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ reply: "La clé API Anthropic est refusée." }, 502);
    console.error("assistant", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : (err as Error).message);
    return json({ reply: "Désolé, j'ai eu un problème. Réessaie." }, 500);
  }
});
