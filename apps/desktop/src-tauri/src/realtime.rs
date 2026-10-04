//! Client Supabase Realtime minimal : une WebSocket, un canal (celui du PC), messages « broadcast ».
//! Protocole Phoenix v1 (objets JSON). Reconnexion automatique avec attente croissante.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::api::{PUBLISHABLE_KEY, SUPABASE_URL};

/// Événement diffusé par le serveur sur le canal du PC.
#[derive(Debug)]
pub struct Broadcast {
    pub event: String,
    pub payload: Value,
}

fn socket_url() -> String {
    let host = SUPABASE_URL.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    format!("wss://{host}/realtime/v1/websocket?apikey={PUBLISHABLE_KEY}&vsn=1.0.0")
}

/// Extrait un broadcast d'un message Phoenix, s'il en est un pour notre canal.
pub fn parse_broadcast(text: &str, channel: &str) -> Option<Broadcast> {
    let msg: Value = serde_json::from_str(text).ok()?;
    if msg["topic"] != channel || msg["event"] != "broadcast" {
        return None;
    }
    Some(Broadcast {
        event: msg["payload"]["event"].as_str()?.to_string(),
        payload: msg["payload"]["payload"].clone(),
    })
}

/// Tourne indéfiniment : se connecte, rejoint le canal, transmet les broadcasts, se reconnecte.
pub async fn run(topic: String, tx: mpsc::Sender<Broadcast>) {
    let channel = format!("realtime:{topic}");
    let mut backoff = 2u64;
    loop {
        match session(&channel, &tx).await {
            Ok(()) => backoff = 2,
            Err(e) => crate::log!("realtime : {e}"),
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(120);
    }
}

async fn session(channel: &str, tx: &mpsc::Sender<Broadcast>) -> Result<(), String> {
    let (ws, _) = connect_async(socket_url()).await.map_err(|e| e.to_string())?;
    crate::log!("realtime : connecté");
    let (mut write, mut read) = ws.split();
    let join = json!({
        "topic": channel,
        "event": "phx_join",
        "payload": { "config": { "broadcast": { "self": false, "ack": false }, "presence": { "key": "" }, "private": false } },
        "ref": "1",
        "join_ref": "1",
    });
    write.send(Message::Text(join.to_string())).await.map_err(|e| e.to_string())?;

    let mut heartbeat = tokio::time::interval(Duration::from_secs(25));
    heartbeat.tick().await;
    let mut next_ref = 2u64;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                let hb = json!({ "topic": "phoenix", "event": "heartbeat", "payload": {}, "ref": next_ref.to_string() });
                next_ref += 1;
                write.send(Message::Text(hb.to_string())).await.map_err(|e| e.to_string())?;
            }
            msg = read.next() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if text.contains("\"phx_reply\"") && text.contains("\"ref\":\"1\"") {
                        crate::log!("realtime : canal rejoint ({})", if text.contains("\"ok\"") { "ok" } else { &text });
                    }
                    if let Some(b) = parse_broadcast(&text, channel) {
                        let _ = tx.send(b).await;
                    } else if text.contains("\"phx_error\"") || text.contains("\"phx_close\"") {
                        return Err(format!("canal fermé : {text}"));
                    }
                }
                Some(Ok(Message::Ping(p))) => { let _ = write.send(Message::Pong(p)).await; }
                Some(Ok(Message::Close(_))) | None => return Err("connexion fermée".into()),
                Some(Err(e)) => return Err(e.to_string()),
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrait_un_broadcast() {
        let text = r#"{"topic":"realtime:jarvis-pc-x","event":"broadcast","payload":{"type":"broadcast","event":"notification","payload":{"title":"T"}},"ref":null}"#;
        let b = parse_broadcast(text, "realtime:jarvis-pc-x").unwrap();
        assert_eq!(b.event, "notification");
        assert_eq!(b.payload["title"], "T");
        assert!(parse_broadcast(text, "realtime:autre").is_none());
        assert!(parse_broadcast(r#"{"topic":"phoenix","event":"phx_reply","payload":{}}"#, "realtime:jarvis-pc-x").is_none());
    }
}
