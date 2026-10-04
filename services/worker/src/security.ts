// Petits garde-fous partagés par les Edge Functions.

const enc = new TextEncoder();

// Comparaison à temps constant (via empreintes SHA-256 de longueur fixe).
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = (await Promise.all([a, b].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))))).map(
    (d) => new Uint8Array(d),
  );
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

// Jarvis n'a qu'un utilisateur : toute autre session est refusée, même valide.
export function isOwner(userId: string | undefined, ownerId: string): boolean {
  return Boolean(userId) && userId === ownerId;
}

// Lit le corps en refusant les requêtes trop volumineuses (avant toute authentification).
export async function readLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  const text = await req.text();
  return enc.encode(text).length > maxBytes ? null : text;
}
