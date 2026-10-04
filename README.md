# Jarvis

Assistant personnel pour la vie étudiante : suit les devoirs Brightspace, envoie des notifications, répond à la voix, et (bientôt) agit sur le PC.

## Architecture

```
Brightspace (flux iCal) ──► sync-brightspace (Edge Function, toutes les 30 min)
                                   │
                                   ▼
                     Supabase Postgres ── Realtime ──► app web/mobile (PWA) et app de bureau (Tauri)
                                   │
                    notify (toutes les 5 min) ──► Web Push (iPhone, navigateurs)
                                   │
              assistant (Claude + outils) ◄── voix/texte depuis les apps
```

| Dossier | Rôle |
|---|---|
| `services/worker/src` | Code partagé Node/Deno : parseur iCal, synchronisation, Web Push (RFC 8291/8292), notifications, assistant |
| `services/worker/scripts` | Outils locaux : `check-feed`, `sync-once`, `sql.ts`, `deploy-functions.ts`… |
| `supabase/migrations` | Schéma SQL (à appliquer dans l'ordre) |
| `supabase/functions` | Edge Functions : `sync-brightspace`, `notify`, `push-test`, `assistant` |
| `apps/web` | App React (Vite), installable sur iPhone, déployée sur Cloudflare Pages |
| `apps/desktop` | App de bureau Tauri : icône dans la barre des tâches, démarrage avec Windows |

## En ligne

- App : https://jarvis-4s2.pages.dev (déployée à chaque `git push` sur `main`)
- Planification (pg_cron) : `sync-brightspace` toutes les 30 min, `notify` toutes les 5 min
- Notifications : nouveaux devoirs (regroupés), échéance modifiée, rappels la veille et 3 h avant, récap à 8 h ; rien entre 23 h et 8 h

## Configuration

Copier `.env.example` en `.env` et remplir. Secrets : jamais dans Git (vérifié avant chaque commit).
`apps/web/.env.production` ne contient que des valeurs publiques (URL du projet, clé publishable, clé VAPID publique).

## Commandes utiles

```bash
npm run check-feed                         # lit le flux Brightspace et affiche le résumé
npm run sync-once                          # synchronisation manuelle vers la base
npm test -w @jarvis/worker                 # tests (chiffrement Web Push, logique des notifications)
npm run dev -w @jarvis/web                 # app web sur http://localhost:5180 (aperçu sans session : /#preview)
cd services/worker && npx tsx --env-file=../../.env scripts/deploy-functions.ts            # secrets + toutes les fonctions
cd services/worker && npx tsx --env-file=../../.env scripts/sql.ts ../../supabase/migrations/XXXX.sql
cd apps/desktop && npx tauri dev           # app de bureau en développement (lancer aussi l'app web)
cd apps/desktop && npx tauri build         # installateur Windows (NSIS)
```

## Avancement

- [x] Synchronisation Brightspace (iCal) dans le cloud
- [x] App web/mobile : devoirs, statuts, temps réel
- [x] Notifications push + récap du matin
- [x] Assistant (texte/voix) — nécessite `ANTHROPIC_API_KEY`
- [x] App de bureau : barre des tâches, démarrage auto (squelette)
- [ ] Mot d'activation « Jarvis » sur PC (Porcupine/openWakeWord)
- [ ] Notifications Windows natives sans WebView ouvert
- [ ] Mail uOttawa (Microsoft Graph)
- [ ] Emploi du temps et planning de révision
- [ ] Contrôle du PC (recettes UI Automation, liste blanche, confirmations)
