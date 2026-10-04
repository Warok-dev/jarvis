use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const MAIN: &str = "main";
/// Argument passé par le démarrage automatique : on reste discret dans la barre des tâches.
const BACKGROUND_ARG: &str = "--background";

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

pub fn run() {
    tauri::Builder::default()
        // Relancer Jarvis alors qu'il tourne déjà : on ouvre simplement la fenêtre.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![BACKGROUND_ARG]),
        ))
        .setup(|app| {
            enable_autostart_once(app.handle());

            let open = MenuItem::with_id(app, "open", "Ouvrir Jarvis", true, None::<&str>)?;
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
            let menu = Menu::with_items(app, &[&open, &startup, &separator, &quit])?;

            let startup_item = startup.clone();
            TrayIconBuilder::with_id("tray")
                .icon(app.default_window_icon().cloned().expect("icône manquante"))
                .tooltip("Jarvis")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "startup" => {
                        // La case est déjà basculée par le menu : on aligne le système dessus.
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
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
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
