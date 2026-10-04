//! Exécution des commandes envoyées au PC (depuis le téléphone ou l'assistant).
//!
//! Garde-fous :
//! - désactivé tant que l'utilisateur ne l'active pas dans le menu de la barre des tâches ;
//! - signature du serveur vérifiée, commande expirée refusée, jamais exécutée deux fois ;
//! - liste blanche d'actions, sans shell arbitraire ; les apps ouvrables sont celles du fichier
//!   `apps.json` (dossier de données de Jarvis), modifiable uniquement sur le PC ;
//! - la saisie de texte n'est permise qu'après avoir ouvert une app ou une URL dans la même commande.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use crate::api::SignedCommand;
use crate::device::Identity;

const MAX_TEXT: usize = 4000;
const MAX_WAIT_MS: u64 = 10_000;
const MAX_STEPS: usize = 12;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct AppEntry {
    pub label: String,
    /// Programme, alias Windows (« code », « chrome »…) ou chemin complet. Jamais fourni par le réseau.
    pub target: String,
}

pub type AppList = BTreeMap<String, AppEntry>;

pub fn default_apps() -> AppList {
    let mut apps = AppList::new();
    for (id, label, target) in [
        ("bloc-notes", "Bloc-notes", "notepad.exe"),
        ("calculatrice", "Calculatrice", "calc.exe"),
        ("explorateur", "Explorateur de fichiers", "explorer.exe"),
        ("vscode", "Visual Studio Code", "code"),
        ("chrome", "Google Chrome", "chrome"),
    ] {
        apps.insert(id.into(), AppEntry { label: label.into(), target: target.into() });
    }
    apps
}

/// Lit `apps.json`, ou le crée avec les apps par défaut.
pub fn load_apps(dir: &Path) -> AppList {
    let file = dir.join("apps.json");
    if let Ok(text) = std::fs::read_to_string(&file) {
        if let Ok(apps) = serde_json::from_str(&text) {
            return apps;
        }
    }
    let apps = default_apps();
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(&file, serde_json::to_string_pretty(&apps).unwrap_or_default());
    apps
}

#[derive(Deserialize, Debug)]
pub struct Command {
    pub id: String,
    pub steps: Vec<Value>,
    pub summary: String,
    pub expires_at: String,
}

#[derive(Debug, PartialEq)]
pub enum Step {
    OpenApp(AppEntry),
    OpenUrl(String),
    TypeText(String),
    PressKey(&'static str),
    Wait(u64),
    Notify(String),
}

/// Vérifie la signature et l'expiration, puis décode la commande.
pub fn authenticate(identity: &Identity, signed: &SignedCommand, now: chrono::DateTime<chrono::Utc>) -> Result<Command, String> {
    if !identity.verify(&format!("cmd:{}", signed.body), &signed.sig) {
        return Err("signature invalide".into());
    }
    let command: Command = serde_json::from_str(&signed.body).map_err(|e| format!("commande illisible : {e}"))?;
    let expires = chrono::DateTime::parse_from_rfc3339(&command.expires_at)
        .map_err(|_| "date d'expiration illisible".to_string())?;
    if expires < now {
        return Err("commande expirée".into());
    }
    Ok(command)
}

/// Traduit les étapes en actions autorisées ; refuse toute la commande au moindre écart.
pub fn validate(steps: &[Value], apps: &AppList) -> Result<Vec<Step>, String> {
    if steps.is_empty() || steps.len() > MAX_STEPS {
        return Err("nombre d'étapes invalide".into());
    }
    let mut out = Vec::new();
    let mut opened_something = false;
    for step in steps {
        let action = step["action"].as_str().unwrap_or_default();
        let parsed = match action {
            "open_app" => {
                let id = step["app"].as_str().unwrap_or_default();
                let entry = apps.get(id).ok_or_else(|| format!("app « {id} » absente de la liste autorisée"))?;
                opened_something = true;
                Step::OpenApp(entry.clone())
            }
            "open_url" => {
                let url = step["url"].as_str().unwrap_or_default();
                let ok = url.starts_with("https://")
                    && url.len() <= 2000
                    && !url.chars().any(|c| c.is_whitespace() || c == '"' || c.is_control());
                if !ok {
                    return Err("URL refusée (https uniquement)".into());
                }
                opened_something = true;
                Step::OpenUrl(url.to_string())
            }
            "type_text" => {
                if !opened_something {
                    return Err("saisie refusée : aucune app ouverte par Jarvis dans cette commande".into());
                }
                let text = step["text"].as_str().unwrap_or_default();
                if text.is_empty() || text.chars().count() > MAX_TEXT {
                    return Err("texte vide ou trop long".into());
                }
                Step::TypeText(text.to_string())
            }
            "press_key" => match step["key"].as_str().unwrap_or_default() {
                "enter" => Step::PressKey("enter"),
                "tab" => Step::PressKey("tab"),
                "escape" => Step::PressKey("escape"),
                other => return Err(format!("touche « {other} » non autorisée")),
            },
            "wait" => Step::Wait(step["ms"].as_u64().unwrap_or(500).min(MAX_WAIT_MS)),
            "notify" => Step::Notify(step["text"].as_str().unwrap_or_default().chars().take(300).collect()),
            other => return Err(format!("action « {other} » non autorisée")),
        };
        out.push(parsed);
    }
    Ok(out)
}

fn spawn(program: &str, args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("lancement impossible : {e}"))
}

/// Exécute les étapes validées. `notify` affiche une notification Windows.
pub async fn execute(steps: Vec<Step>, notify: impl Fn(&str)) -> Result<(), String> {
    for step in steps {
        match step {
            // La cible vient de apps.json (local) : « start » résout les alias comme « code » ou « chrome ».
            Step::OpenApp(app) => spawn("cmd", &["/C", "start", "", &app.target])?,
            // Pas de shell : explorer.exe reçoit l'URL telle quelle et ouvre le navigateur par défaut.
            Step::OpenUrl(url) => spawn("explorer.exe", &[&url])?,
            Step::TypeText(text) => keyboard(move |k| {
                use enigo::Keyboard;
                k.text(&text).map_err(|e| e.to_string())
            })
            .await?,
            Step::PressKey(name) => keyboard(move |k| {
                use enigo::{Direction, Key, Keyboard};
                let key = match name {
                    "enter" => Key::Return,
                    "tab" => Key::Tab,
                    _ => Key::Escape,
                };
                k.key(key, Direction::Click).map_err(|e| e.to_string())
            })
            .await?,
            Step::Wait(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
            Step::Notify(text) => notify(&text),
        }
    }
    Ok(())
}

async fn keyboard(f: impl FnOnce(&mut enigo::Enigo) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut enigo = enigo::Enigo::new(&enigo::Settings::default()).map_err(|e| e.to_string())?;
        f(&mut enigo)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepte_une_sequence_autorisee() {
        let steps = vec![
            json!({"action": "open_app", "app": "vscode"}),
            json!({"action": "wait", "ms": 99999}),
            json!({"action": "type_text", "text": "bonjour"}),
            json!({"action": "press_key", "key": "enter"}),
        ];
        let parsed = validate(&steps, &default_apps()).unwrap();
        assert_eq!(parsed[1], Step::Wait(MAX_WAIT_MS));
        assert_eq!(parsed[3], Step::PressKey("enter"));
    }

    #[test]
    fn refuse_les_ecarts() {
        let apps = default_apps();
        assert!(validate(&[json!({"action": "open_app", "app": "cmd"})], &apps).is_err());
        assert!(validate(&[json!({"action": "run_shell", "cmd": "del"})], &apps).is_err());
        assert!(validate(&[json!({"action": "type_text", "text": "x"})], &apps).is_err());
        assert!(validate(&[json!({"action": "open_url", "url": "http://exemple.com"})], &apps).is_err());
        assert!(validate(&[json!({"action": "open_url", "url": "https://a.com\" & calc"})], &apps).is_err());
        assert!(validate(&[json!({"action": "press_key", "key": "alt+f4"})], &apps).is_err());
        assert!(validate(&[], &apps).is_err());
    }

    #[test]
    fn verifie_signature_et_expiration() {
        let identity = Identity { id: "pc".into(), secret: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8".into(), registered: true };
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-04T06:00:00Z").unwrap().with_timezone(&chrono::Utc);
        let body = r#"{"id":"c1","steps":[],"summary":"s","expires_at":"2026-10-04T06:01:00.123+00:00"}"#.to_string();
        let ok = SignedCommand { sig: identity.sign(&format!("cmd:{body}")), body: body.clone() };
        assert!(authenticate(&identity, &ok, now).is_ok());
        let forged = SignedCommand { sig: ok.sig.clone(), body: body.replace("c1", "c2") };
        assert!(authenticate(&identity, &forged, now).is_err());
        let later = now + chrono::Duration::minutes(5);
        assert_eq!(authenticate(&identity, &ok, later).unwrap_err(), "commande expirée");
    }
}
