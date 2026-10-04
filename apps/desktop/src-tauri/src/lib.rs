mod api;
mod device;
mod executor;
mod listen;
mod log;
mod realtime;
mod wakeword;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, Mutex, Notify};

use api::{Api, SignedCommand};
use device::Identity;

const MAIN: &str = "main";
/// Argument passé par le démarrage automatique : on reste discret dans la barre des tâches.
const BACKGROUND_ARG: &str = "--background";
const HEARTBEAT_EVERY: Duration = Duration::from_secs(60);

/// État partagé du lien avec le cloud.
struct Link {
    identity: Mutex<Identity>,
    api: Api,
    registered: Notify,
    /// Commandes à distance autorisées (désactivé par défaut, réglage persistant).
    remote_enabled: AtomicBool,
    /// Commandes déjà vues (id → expiration), purgées après expiration.
    executed: Mutex<HashMap<String, chrono::DateTime<chrono::Utc>>>,
    /// Une seule commande exécutée à la fois (sans bloquer la boucle principale).
    running: Mutex<()>,
}

// ---------- Fenêtre ----------

/// Affiche la fenêtre, en la recréant si elle a été fermée.
/// Au repos il n'existe aucune fenêtre : le WebView n'occupe pas de mémoire.
/// `wake` : ouverte par le mot d'activation → la fenêtre ouvre directement la conversation.
fn show_main(app: &AppHandle, wake: bool) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if wake {
            let _ = window.emit("jarvis-wake", ());
        }
        return;
    }
    // Indicateur injecté avant le chargement de la page : indépendant de l’URL et du protocole.
    let script = if wake { "window.__JARVIS_WAKE__ = true;" } else { "" };
    let _ = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .initialization_script(script)
        .title("Jarvis")
        .inner_size(440.0, 780.0)
        .min_inner_size(360.0, 520.0)
        .focused(true)
        .on_navigation(|url| {
            matches!(url.host_str(), Some("tauri.localhost") | Some("localhost")) || url.scheme() == "tauri"
        })
        .build();
}

// ---------- Mot d'activation ----------

/// Écoute en cours (None = désactivée). Le WebView n'est pas nécessaire pour écouter.
struct Wake {
    listener: std::sync::Mutex<Option<listen::Listener>>,
}

/// Lance la dictée vocale de Windows (Win+H) dans le champ de Jarvis.
fn start_dictation() {
    use enigo::{Direction, Enigo, Key, Keyboard, Settings};
    if let Ok(mut e) = Enigo::new(&Settings::default()) {
        let _ = e.key(Key::Meta, Direction::Press);
        let _ = e.key(Key::Unicode('h'), Direction::Click);
        let _ = e.key(Key::Meta, Direction::Release);
    }
}

fn set_wake(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<Wake>();
    let mut slot = state.listener.lock().unwrap_or_else(|e| e.into_inner());
    if !enabled {
        *slot = None; // l'arrêt du thread libère le micro
        log!("écoute du mot d'activation désactivée");
        return Ok(());
    }
    if slot.is_some() {
        return Ok(());
    }
    let models = app
        .path()
        .resolve("wakeword", tauri::path::BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    let settings = read_settings(app);
    let threshold = settings["wake_threshold"].as_f64().map(|t| t as f32).unwrap_or(wakeword::DEFAULT_THRESHOLD);
    let dictation = settings["wake_dictation"].as_bool().unwrap_or(true);
    let handle = app.clone();
    let listener = listen::Listener::start(models, threshold, move |score| {
        log!("« Hey Jarvis » détecté (score {score:.2})");
        let h = handle.clone();
        let _ = handle.run_on_main_thread(move || show_main(&h, true));
        if dictation {
            // Laisse la fenêtre prendre le focus, puis démarre la dictée Windows dans le champ.
            let h = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(900));
                let focused = h.get_webview_window(MAIN).and_then(|w| w.is_focused().ok()).unwrap_or(false);
                if focused {
                    start_dictation();
                } else {
                    log!("dictée non lancée : la fenêtre de Jarvis n'a pas le focus");
                }
            });
        }
    })?;
    *slot = Some(listener);
    log!("écoute du mot d'activation active (seuil {threshold:.2})");
    Ok(())
}

fn toast(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------- Réglages persistants ----------

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

/// Réglages : remote_commands, wake_word, wake_threshold, wake_dictation.
fn read_settings(app: &AppHandle) -> serde_json::Value {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| json!({}))
}

/// Modifie un réglage en conservant les autres.
fn write_setting(app: &AppHandle, key: &str, value: serde_json::Value) {
    if let Some(path) = settings_path(app) {
        let mut settings = read_settings(app);
        settings[key] = value;
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&settings).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn load_remote_enabled(app: &AppHandle) -> bool {
    read_settings(app)["remote_commands"].as_bool().unwrap_or(false)
}

fn save_remote_enabled(app: &AppHandle, enabled: bool) {
    write_setting(app, "remote_commands", json!(enabled));
}

/// Active le démarrage avec Windows au tout premier lancement.
fn enable_autostart_once(app: &AppHandle) {
    // Jamais pour un binaire de développement (il vit dans target/ et change à chaque build).
    if cfg!(debug_assertions) {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let marker = dir.join("autostart-initialized");
    if marker.exists() {
        return;
    }
    let _ = app.autolaunch().enable();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(marker, b"1");
}

// ---------- Lien avec le cloud ----------

/// Appelée par la fenêtre après connexion : associe ce PC au compte (une fois).
#[tauri::command]
async fn register_device(app: AppHandle, access_token: String) -> Result<String, String> {
    let link = app.state::<Arc<Link>>();
    let mut identity = link.identity.lock().await;
    let label = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into());
    link.api.register(&identity, &access_token, &label).await?;
    if !identity.registered {
        identity.registered = true;
        identity.save()?;
    }
    link.registered.notify_one();
    Ok(label)
}

/// Exécute (ou refuse) une commande signée reçue du serveur. Tourne dans sa propre tâche.
async fn handle_command(app: AppHandle, link: Arc<Link>, signed: SignedCommand) {
    let identity = link.identity.lock().await.clone();
    let now = chrono::Utc::now();
    let command = match executor::authenticate(&identity, &signed, now) {
        Ok(c) => c,
        Err(e) => return log!("commande ignorée : {e}"),
    };
    // La même commande peut arriver par le canal temps réel et par le battement de cœur.
    {
        let mut seen = link.executed.lock().await;
        seen.retain(|_, until| *until > now);
        if seen.contains_key(&command.id) {
            return;
        }
        let until = chrono::DateTime::parse_from_rfc3339(&command.expires_at)
            .map(|d| d.with_timezone(&chrono::Utc))
            .unwrap_or(now);
        seen.insert(command.id.clone(), until);
    }
    let report = |status: &'static str, result: String| {
        let identity = identity.clone();
        let id = command.id.clone();
        let link = link.clone();
        async move {
            if let Err(e) = link.api.report(&identity, &id, status, &result).await {
                log!("rapport impossible : {e}");
            }
        }
    };
    if !link.remote_enabled.load(Ordering::Relaxed) {
        toast(&app, "Jarvis", &format!("Commande refusée : « {} ». Active les commandes à distance dans le menu de Jarvis.", command.summary));
        return report("rejected", "Commandes à distance désactivées sur le PC".into()).await;
    }
    let apps = executor::load_apps(&app.path().app_data_dir().unwrap_or_default());
    let steps = match executor::validate(&command.steps, &apps) {
        Ok(s) => s,
        Err(e) => return report("rejected", e).await,
    };
    // Réservation atomique côté serveur (horloge du serveur) : une commande rejouée,
    // déjà traitée ou expirée n'est jamais exécutée, même après un redémarrage du PC.
    match link.api.claim(&identity, &command.id).await {
        Ok(true) => {}
        Ok(false) => return log!("commande déjà traitée ou expirée"),
        Err(e) => return log!("réservation impossible : {e}"),
    }
    let _turn = link.running.lock().await;
    toast(&app, "Jarvis agit sur ton PC", &command.summary);
    let notifier = |text: &str| toast(&app, "Jarvis", text);
    match executor::execute(steps, notifier).await {
        Ok(()) => report("done", "OK".into()).await,
        Err(e) => report("failed", e).await,
    }
}

/// Notification diffusée par le serveur : affichée seulement si elle est signée et récente.
async fn handle_notification(app: &AppHandle, link: &Link, payload: serde_json::Value) {
    let Ok(signed) = serde_json::from_value::<SignedCommand>(payload) else {
        return log!("notification non signée ignorée");
    };
    let identity = link.identity.lock().await.clone();
    if !identity.verify(&format!("notif:{}", signed.body), &signed.sig) {
        return log!("notification à signature invalide ignorée");
    }
    let n: serde_json::Value = serde_json::from_str(&signed.body).unwrap_or_default();
    let now = chrono::Utc::now();
    let fresh = n["expires_at"]
        .as_str()
        .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
        .map(|d| d > now && d < now + chrono::Duration::minutes(15))
        .unwrap_or(false);
    if !fresh {
        return log!("notification expirée ignorée");
    }
    toast(app, n["title"].as_str().unwrap_or("Jarvis"), n["body"].as_str().unwrap_or(""));
}

async fn heartbeat_once(app: &AppHandle, link: &Arc<Link>) {
    let identity = link.identity.lock().await.clone();
    let apps = executor::load_apps(&app.path().app_data_dir().unwrap_or_default());
    let extra = json!({
        "apps": apps.iter().map(|(id, a)| json!({ "id": id, "label": a.label })).collect::<Vec<_>>(),
        "remote_enabled": link.remote_enabled.load(Ordering::Relaxed),
    });
    match link.api.heartbeat(&identity, extra).await {
        Ok(commands) => {
            if !commands.is_empty() {
                log!("battement : {} commande(s) en attente", commands.len());
            }
            for c in commands {
                tauri::async_runtime::spawn(handle_command(app.clone(), link.clone(), c));
            }
        }
        Err(e) => log!("battement : {e}"),
    }
}

/// Tâche de fond : attend l'association au compte, puis présence + canal temps réel.
async fn background(app: AppHandle, link: Arc<Link>) {
    if !link.identity.lock().await.registered {
        link.registered.notified().await;
    }
    let topic = link.identity.lock().await.topic();
    let (tx, mut rx) = mpsc::channel(32);
    tauri::async_runtime::spawn(realtime::run(topic, tx));

    let mut ticker = tokio::time::interval(HEARTBEAT_EVERY);
    loop {
        tokio::select! {
            _ = ticker.tick() => heartbeat_once(&app, &link).await,
            Some(b) = rx.recv() => {
                log!("reçu : {}", b.event);
                match b.event.as_str() {
                "notification" => handle_notification(&app, &link, b.payload).await,
                "command" => {
                    if let Ok(signed) = serde_json::from_value::<SignedCommand>(b.payload) {
                        tauri::async_runtime::spawn(handle_command(app.clone(), link.clone(), signed));
                    }
                }
                _ => {}
                }
            }
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        // Relancer Jarvis alors qu'il tourne déjà : on ouvre simplement la fenêtre.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app, false)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![BACKGROUND_ARG])))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![register_device])
        .setup(|app| {
            if let Ok(dir) = app.path().app_data_dir() {
                log::init(dir);
            }
            log!("démarrage de Jarvis {}", env!("CARGO_PKG_VERSION"));
            enable_autostart_once(app.handle());

            let identity = Identity::load_or_create().map_err(|e| format!("identité du PC : {e}"))?;
            // En debug, JARVIS_TEST_REMOTE=1 autorise les commandes pour un test, sans toucher au réglage enregistré.
            let remote = load_remote_enabled(app.handle())
                || (cfg!(debug_assertions) && std::env::var("JARVIS_TEST_REMOTE").as_deref() == Ok("1"));
            let link = Arc::new(Link {
                identity: Mutex::new(identity),
                api: Api::new(),
                registered: Notify::new(),
                remote_enabled: AtomicBool::new(remote),
                executed: Mutex::new(HashMap::new()),
                running: Mutex::new(()),
            });
            app.manage(link.clone());
            tauri::async_runtime::spawn(background(app.handle().clone(), link.clone()));

            let open = MenuItem::with_id(app, "open", "Ouvrir Jarvis", true, None::<&str>)?;
            let remote_item = CheckMenuItem::with_id(app, "remote", "Autoriser les commandes à distance", true, remote, None::<&str>)?;
            // Mot d'activation : désactivé par défaut, le micro n'est ouvert que si l'utilisateur l'active.
            app.manage(Wake { listener: std::sync::Mutex::new(None) });
            let wake_on = read_settings(app.handle())["wake_word"].as_bool().unwrap_or(false);
            let wake_item = CheckMenuItem::with_id(app, "wake", "Écoute « Hey Jarvis »", true, wake_on, None::<&str>)?;
            if wake_on {
                if let Err(e) = set_wake(app.handle(), true) {
                    log!("écoute impossible au démarrage : {e}");
                    let _ = wake_item.set_checked(false);
                }
            }
            let startup = CheckMenuItem::with_id(
                app,
                "startup",
                "Démarrer avec Windows",
                true,
                app.autolaunch().is_enabled().unwrap_or(false),
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quitter Jarvis", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &wake_item, &remote_item, &startup, &separator, &quit])?;

            let startup_item = startup.clone();
            let remote_check = remote_item.clone();
            let wake_check = wake_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("icône manquante"))
                .tooltip("Jarvis")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app, false),
                    // Les cases sont déjà basculées par le menu : on aligne l'état dessus.
                    "wake" => {
                        let enabled = wake_check.is_checked().unwrap_or(false);
                        match set_wake(app, enabled) {
                            Ok(()) => write_setting(app, "wake_word", json!(enabled)),
                            Err(e) => {
                                log!("écoute impossible : {e}");
                                let _ = wake_check.set_checked(false);
                                toast(app, "Jarvis", &format!("Écoute impossible : {e}"));
                            }
                        }
                    }
                    "remote" => {
                        let enabled = remote_check.is_checked().unwrap_or(false);
                        app.state::<Arc<Link>>().remote_enabled.store(enabled, Ordering::Relaxed);
                        save_remote_enabled(app, enabled);
                    }
                    "startup" => {
                        let autolaunch = app.autolaunch();
                        let _ = if startup_item.is_checked().unwrap_or(false) {
                            autolaunch.enable()
                        } else {
                            autolaunch.disable()
                        };
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle(), false);
                    }
                })
                .build(app)?;

            // Test (debug uniquement) : simule une détection du mot d’activation, sans micro ni dictée.
            if cfg!(debug_assertions) && std::env::var("JARVIS_TEST_WAKE").as_deref() == Ok("1") {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(3));
                    log!("test : réveil simulé");
                    let h2 = h.clone();
                    let _ = h.run_on_main_thread(move || show_main(&h2, true));
                });
            }

            // Lancement manuel : on montre la fenêtre. Démarrage de Windows : on reste discret.
            if !std::env::args().any(|a| a == BACKGROUND_ARG) {
                show_main(app.handle(), false);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erreur au démarrage de Jarvis")
        .run(|_app, event| {
            // Fermer la fenêtre détruit le WebView (mémoire libérée) mais Jarvis reste actif.
            // Seul « Quitter » (exit avec un code) termine réellement l'application.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                api.prevent_exit();
            }
        });
}
