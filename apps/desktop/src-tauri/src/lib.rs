mod api;
mod device;
mod executor;
mod log;
mod realtime;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
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
    executed: Mutex<HashSet<String>>,
}

// ---------- Fenêtre ----------

/// Affiche la fenêtre, en la recréant si elle a été fermée.
/// Au repos il n'existe aucune fenêtre : le WebView n'occupe pas de mémoire.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Jarvis")
        .inner_size(440.0, 780.0)
        .min_inner_size(360.0, 520.0)
        .build();
}

fn toast(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------- Réglages persistants ----------

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

fn load_remote_enabled(app: &AppHandle) -> bool {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["remote_commands"].as_bool())
        .unwrap_or(false)
}

fn save_remote_enabled(app: &AppHandle, enabled: bool) {
    if let Some(path) = settings_path(app) {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(path, json!({ "remote_commands": enabled }).to_string());
    }
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

/// Exécute (ou refuse) une commande signée reçue du serveur.
async fn handle_command(app: &AppHandle, link: &Link, signed: SignedCommand) {
    let identity = link.identity.lock().await.clone();
    let command = match executor::authenticate(&identity, &signed, chrono::Utc::now()) {
        Ok(c) => c,
        Err(e) => return log!("commande ignorée : {e}"),
    };
    // La même commande peut arriver par le canal temps réel et par le battement de cœur.
    if !link.executed.lock().await.insert(command.id.clone()) {
        return;
    }
    let report = |status: &'static str, result: String| {
        let identity = identity.clone();
        let id = command.id.clone();
        async move {
            if let Err(e) = link.api.report(&identity, &id, status, &result).await {
                log!("rapport impossible : {e}");
            }
        }
    };
    if !link.remote_enabled.load(Ordering::Relaxed) {
        toast(app, "Jarvis", &format!("Commande refusée : « {} ». Active les commandes à distance dans le menu de Jarvis.", command.summary));
        return report("rejected", "Commandes à distance désactivées sur le PC".into()).await;
    }
    let apps = executor::load_apps(&app.path().app_data_dir().unwrap_or_default());
    let steps = match executor::validate(&command.steps, &apps) {
        Ok(s) => s,
        Err(e) => return report("rejected", e).await,
    };
    toast(app, "Jarvis agit sur ton PC", &command.summary);
    report("running", String::new()).await;
    let notifier = |text: &str| toast(app, "Jarvis", text);
    match executor::execute(steps, notifier).await {
        Ok(()) => report("done", "OK".into()).await,
        Err(e) => report("failed", e).await,
    }
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
                handle_command(app, link, c).await;
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
                "notification" => toast(
                    &app,
                    b.payload["title"].as_str().unwrap_or("Jarvis"),
                    b.payload["body"].as_str().unwrap_or(""),
                ),
                "command" => {
                    if let Ok(signed) = serde_json::from_value::<SignedCommand>(b.payload) {
                        handle_command(&app, &link, signed).await;
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
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
                executed: Mutex::new(HashSet::new()),
            });
            app.manage(link.clone());
            tauri::async_runtime::spawn(background(app.handle().clone(), link.clone()));

            let open = MenuItem::with_id(app, "open", "Ouvrir Jarvis", true, None::<&str>)?;
            let remote_item = CheckMenuItem::with_id(app, "remote", "Autoriser les commandes à distance", true, remote, None::<&str>)?;
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
            let menu = Menu::with_items(app, &[&open, &remote_item, &startup, &separator, &quit])?;

            let startup_item = startup.clone();
            let remote_check = remote_item.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("icône manquante"))
                .tooltip("Jarvis")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    // Les cases sont déjà basculées par le menu : on aligne l'état dessus.
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
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Lancement manuel : on montre la fenêtre. Démarrage de Windows : on reste discret.
            if !std::env::args().any(|a| a == BACKGROUND_ARG) {
                show_main(app.handle());
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
