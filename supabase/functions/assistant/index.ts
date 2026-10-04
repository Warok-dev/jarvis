// Conversation avec Jarvis (texte ou voix transcrite) depuis l'app web/mobile et, plus tard, le PC.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import type { ChatTurn } from "../../../services/worker/src/assistant/assistant.ts";
import { respond, type Providers } from "../../../services/worker/src/assistant/brain.ts";
import { GeminiError } from "../../../services/worker/src/assistant/gemini.ts";
import { createAdminClient } from "../../../services/worker/src/db.ts";
import { isOwner } from "../../../services/worker/src/security.ts";

// tauri.localhost : app de bureau Windows.
const ALLOWED_ORIGINS = ["https://jarvis-4s2.pages.dev", "http://tauri.localhost", "http://localhost:5180"];
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

  // Fournisseur : Gemini (offre gratuite) par défaut ; Claude si LLM_PROVIDER=claude et clé fournie.
  // Sans aucune clé, l'interpréteur local répond aux demandes courantes.
  const providers: Providers = {};
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  const preferClaude = Deno.env.get("LLM_PROVIDER") === "claude" && anthropicKey;
  if (geminiKey && !preferClaude) providers.gemini = { apiKey: geminiKey, model: Deno.env.get("GEMINI_MODEL") ?? "gemini-flash-latest" };
  else if (anthropicKey) providers.claude = new Anthropic({ apiKey: anthropicKey });

  // Client à la session de l'utilisateur : RLS s'applique à chaque outil.
  const authorization = req.headers.get("authorization") ?? "";
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("JARVIS_PUBLISHABLE_KEY")!, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user } } = await db.auth.getUser(authorization.replace(/^Bearer\s+/i, ""));
  if (!user) return json({ reply: "Session expirée, reconnecte-toi." }, 401);
  if (!isOwner(user.id, Deno.env.get("JARVIS_USER_ID") ?? "")) return json({ reply: "Accès refusé." }, 403);

  let body: { messages?: ChatTurn[]; device?: string };
  try {
    body = await req.json();
  } catch {
    return json({ reply: "Requête invalide." }, 400);
  }
  if (!Array.isArray(body?.messages)) return json({ reply: "Requête invalide." }, 400);
  const history = body.messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") return json({ reply: "Je n'ai rien entendu." }, 400);

  const device = body.device === "mobile" || body.device === "desktop" ? body.device : "web";
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const secretKey = Deno.env.get("JARVIS_SECRET_KEY")!;
    const pc = { admin: createAdminClient(supabaseUrl, secretKey), userId: user.id, supabaseUrl, secretKey };
    const result = await respond(db, history, device, providers, pc);
    console.log("assistant", result.via);
    return json(result);
  } catch (err) {
    if (err instanceof GeminiError) {
      console.error("assistant gemini", err.status, err.message.slice(0, 200));
      if (err.status === 429) return json({ reply: "J'ai atteint mon quota gratuit pour le moment. Réessaie dans une minute." }, 429);
      return json({ reply: "Mon cerveau en ligne ne répond pas. Réessaie dans un instant." }, 502);
    }
    if (err instanceof Anthropic.RateLimitError) return json({ reply: "Je suis un peu débordé, réessaie dans une minute." }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ reply: "La clé API Anthropic est refusée." }, 502);
    console.error("assistant", err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : (err as Error).message);
    return json({ reply: "Désolé, j'ai eu un problème. Réessaie." }, 500);
  }
});
