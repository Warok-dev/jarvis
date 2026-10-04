# Jarvis

Assistant personnel pour la vie étudiante : suit les devoirs Brightspace, envoie des notifications, répond à la voix, et (bientôt) agit sur le PC.

Pour démarrer : **[docs/DEMARRAGE.md](docs/DEMARRAGE.md)** (iPhone, clé de l’assistant, app de bureau).

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
| `supabase/functions` | Edge Functions : `sync-brightspace`, `notify`, `push-test`, `assistant`, `device`, `plan` |
| `apps/web` | App React (Vite), installable sur iPhone, déployée sur Cloudflare Pages |
| `apps/desktop` | App de bureau Tauri : icône dans la barre des tâches, démarrage avec Windows |

## En ligne

- App : https://jarvis-4s2.pages.dev (déployée à chaque `git push` sur `main`)
- Planification (pg_cron) : `sync-brightspace` toutes les 30 min, `notify` toutes les 5 min, `plan` chaque matin
- Notifications : nouveaux devoirs (regroupés), échéance modifiée, rappels la veille et 3 h avant, récap à 8 h ; rien entre 23 h et 8 h

## Le PC et le cloud

L'app de bureau n'utilise pas la session de la fenêtre : au premier lancement elle crée un
**secret d'appareil** (Gestionnaire d'identifiants Windows), associé au compte une fois après
la connexion dans la fenêtre. Ensuite :

- battement de cœur signé (HMAC) toutes les 60 s → indicateur « PC en ligne » dans l'app ;
- canal temps réel privé (dérivé du secret) → notifications Windows natives, commandes ;
- commandes signées par le serveur, expirées après 2 min, exécutées une seule fois ;
- **commandes à distance désactivées par défaut** (menu de la barre des tâches) ;
- liste blanche : ouvrir une app de `%APPDATA%\dev.warok.jarvis\apps.json`, ouvrir une URL https,
  taper du texte (seulement après avoir ouvert une app), Entrée/Tab/Échap, attendre ;
- journal : `%APPDATA%\dev.warok.jarvis\jarvis.log`.

Mot d'activation (menu « Écoute « Hey Jarvis » », désactivé par défaut) : détection 100 % locale
(modèles openWakeWord, `resources/wakeword`), environ 3 % d'un cœur quand il y a du son et quasiment
rien en silence. Au réveil : la fenêtre s'ouvre sur la conversation et la dictée Windows (Win+H)
démarre dans le champ. Réglages dans `settings.json` : `wake_threshold` (0,3), `wake_dictation` (true).

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
- [x] Assistant (texte/voix) : interpréteur local gratuit + Gemini Flash (offre gratuite), Claude en option
- [x] App de bureau : barre des tâches, démarrage auto
- [x] PC relié au cloud : présence, notifications Windows natives, commandes signées
- [x] Contrôle du PC, niveau 1 : actions en liste blanche via l'assistant (« ouvre VS Code »)
- [x] Mot d'activation « Hey Jarvis » sur PC : openWakeWord local (tract), porte d'énergie, désactivé par défaut
- [ ] Mail uOttawa (Microsoft Graph)
- [x] Planning de révision : durées estimées, disponibilités, EDF, alerte « temps manquant », récap du matin
- [ ] Horaire de cours uOttawa (prêt : renseigner `TIMETABLE_ICAL_URL`)
- [ ] Contrôle du PC, niveau 2 : recettes UI Automation par app
