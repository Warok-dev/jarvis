//! Appels HTTP vers la fonction cloud `device` (enregistrement, présence, résultats).

use crate::device::Identity;
use serde::Deserialize;
use serde_json::{json, Value};

pub const SUPABASE_URL: &str = env!("JARVIS_SUPABASE_URL");
pub const PUBLISHABLE_KEY: &str = env!("JARVIS_SUPABASE_PUBLISHABLE_KEY");

fn endpoint(route: &str) -> String {
    format!("{}/functions/v1/device/{route}", SUPABASE_URL.trim_end_matches('/'))
}

/// Commande signée par le serveur : `body` est la chaîne JSON exacte qui a été signée.
#[derive(Deserialize, Clone, Debug)]
pub struct SignedCommand {
    pub body: String,
    pub sig: String,
}

#[derive(Deserialize)]
struct HeartbeatResponse {
    #[serde(default)]
    commands: Vec<SignedCommand>,
}

pub struct Api {
    http: reqwest::Client,
}

impl Api {
    pub fn new() -> Self {
        Api {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .expect("client HTTP"),
        }
    }

    /// Associe ce PC au compte, avec la session de la fenêtre (une seule fois).
    pub async fn register(&self, identity: &Identity, access_token: &str, label: &str) -> Result<(), String> {
        let res = self
            .http
            .post(endpoint("register"))
            .bearer_auth(access_token)
            .header("apikey", PUBLISHABLE_KEY)
            .json(&json!({ "device_id": identity.id, "secret": identity.secret, "label": label }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(format!("enregistrement refusé ({})", res.status()))
        }
    }

    async fn signed(&self, identity: &Identity, route: &str, mut body: Value) -> Result<Value, String> {
        body["device_id"] = json!(identity.id);
        body["ts"] = json!(chrono::Utc::now().timestamp());
        let raw = body.to_string();
        let res = self
            .http
            .post(endpoint(route))
            .header("apikey", PUBLISHABLE_KEY)
            .header("x-jarvis-signature", identity.sign(&raw))
            .header("content-type", "application/json")
            .body(raw)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = res.status();
        let value: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(value)
        } else {
            Err(format!("{route} refusé ({status}) {value}"))
        }
    }

    /// Signale que le PC est allumé et récupère les commandes en attente.
    /// `extra` : apps ouvrables et réglage des commandes à distance (pour l'assistant).
    pub async fn heartbeat(&self, identity: &Identity, extra: Value) -> Result<Vec<SignedCommand>, String> {
        let value = self.signed(identity, "heartbeat", extra).await?;
        let parsed: HeartbeatResponse = serde_json::from_value(value).map_err(|e| e.to_string())?;
        Ok(parsed.commands)
    }

    pub async fn report(&self, identity: &Identity, command_id: &str, status: &str, result: &str) -> Result<(), String> {
        self.signed(identity, "result", json!({ "command_id": command_id, "status": status, "result": result }))
            .await
            .map(|_| ())
    }
}
