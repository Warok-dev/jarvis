# Mise en route de Jarvis

Ce qui demande ton intervention, dans l'ordre. Tout le reste tourne déjà dans le cloud
(synchronisation Brightspace toutes les 30 min, notifications toutes les 5 min, planning chaque matin).

## 1. iPhone (5 min)

1. Ouvre **https://jarvis-4s2.pages.dev** dans **Safari** (pas Chrome).
2. Partager → **Sur l'écran d'accueil** → Ajouter.
3. Lance Jarvis **depuis l'icône**, connecte-toi.
4. Touche **Activer** (notifications), puis **Tester** : une notification doit arriver.
5. Ouvre **Planning → Disponibilités** : ajuste tes plages et ajoute tes cours fixes.

## 2. L'assistant (gratuit)

Les demandes courantes sont comprises **localement**, sans IA ni coût : « Qu'est-ce que j'ai à rendre
demain ? », « Mon planning », « J'ai fini le lab 1 d'ELG », « Je commence le devoir d'économie 2 »,
« Ouvre VS Code ». Les autres questions partent vers **Gemini Flash** (offre gratuite de Google,
clé `GEMINI_API_KEY` dans `.env`), avec repli automatique sur Flash-Lite en cas de forte demande.

Après toute modification de `.env` :

```bash
cd C:UsersGBDesktopProjet_persojarvisservicesworker && npx tsx --env-file=../../.env scripts/deploy-functions.ts assistant
```

Pour passer un jour à Claude (payant) : `ANTHROPIC_API_KEY=…` et `LLM_PROVIDER=claude` dans `.env`.

## 3. App de bureau (5 min)

1. Lance `apps\desktop\src-tauri\target\release\bundle\nsis\Jarvis_0.1.0_x64-setup.exe`
   (installation pour ton compte seulement, pas besoin d'administrateur).
2. Jarvis s'ouvre : **connecte-toi** dans la fenêtre. Le PC est alors associé à ton compte
   (l'indicateur « PC » devient vert dans l'app du téléphone).
3. Dans le menu de l'icône (barre des tâches, clic droit), selon ce que tu veux :
   - **Écoute « Hey Jarvis »** : active le micro pour le mot d'activation (100 % local).
     Dis « Hey Jarvis » : la fenêtre s'ouvre et la dictée Windows démarre — parle, puis Entrée.
     Si le déclenchement est trop ou pas assez sensible : `wake_threshold` dans
     `%APPDATA%\dev.warok.jarvis\settings.json` (0,3 par défaut ; plus haut = moins sensible).
   - **Autoriser les commandes à distance** : permet « ouvre VS Code » ou « donne le devoir 1 à
     ChatGPT » depuis le téléphone. Les apps ouvrables sont dans
     `%APPDATA%\dev.warok.jarvis\apps.json` (ajoute les tiennes : identifiant, nom, programme).
4. Fermer la fenêtre libère sa mémoire ; Jarvis reste dans la barre des tâches.

## 4. Optionnel

- **Horaire de cours** : si uOttawa te permet d'exporter ton horaire en iCal, ajoute
  `TIMETABLE_ICAL_URL=…` dans `.env` puis relance la commande de déploiement (sans argument).
  Sinon, saisis tes cours dans *Disponibilités* — c'est équivalent.
- **Mail uOttawa** : nécessite une application Microsoft Entra (Azure) et le consentement de
  l'université pour Microsoft Graph (`Mail.Read`). À voir ensemble ; en attendant, active les
  notifications Brightspace par courriel (Brightspace → ton nom → Notifications).

## Où regarder si quelque chose ne marche pas

- Journal du PC : `%APPDATA%\dev.warok.jarvis\jarvis.log`
- Supabase → Integrations → Cron : historique des tâches planifiées
- Supabase → Edge Functions → Logs
