//! Identité du PC : identifiant + secret d'appareil.
//!
//! Le secret (32 octets) est généré ici, stocké dans le Gestionnaire d'identifiants Windows,
//! et sert à signer chaque échange avec le serveur (HMAC-SHA256). Les dérivations sont
//! identiques à `services/worker/src/devices/device-auth.ts` (vecteurs de test communs).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const KEYRING_SERVICE: &str = "dev.warok.jarvis";
const KEYRING_USER: &str = "device";

#[derive(Clone, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub secret: String,
    /// Vrai une fois l'appareil associé au compte (après connexion dans la fenêtre).
    #[serde(default)]
    pub registered: bool,
}

impl Identity {
    fn generate() -> Self {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        Identity { id: uuid::Uuid::new_v4().to_string(), secret: URL_SAFE_NO_PAD.encode(bytes), registered: false }
    }

    /// Charge l'identité, ou la crée au premier lancement.
    pub fn load_or_create() -> Result<Self, String> {
        // Tests de développement uniquement : identité imposée par variables d'environnement.
        if cfg!(debug_assertions) {
            if let (Ok(id), Ok(secret)) = (std::env::var("JARVIS_DEVICE_ID"), std::env::var("JARVIS_DEVICE_SECRET")) {
                return Ok(Identity { id, secret, registered: true });
            }
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
            Err(keyring::Error::NoEntry) => {
                let identity = Self::generate();
                identity.save()?;
                Ok(identity)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        if cfg!(debug_assertions) && std::env::var("JARVIS_DEVICE_ID").is_ok() {
            return Ok(());
        }
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
        entry.set_password(&serde_json::to_string(self).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    }

    pub fn sign(&self, message: &str) -> String {
        sign(&self.secret, message)
    }

    pub fn verify(&self, message: &str, signature: &str) -> bool {
        verify(&self.secret, message, signature)
    }

    pub fn topic(&self) -> String {
        topic_for(&self.secret)
    }
}

type HmacSha256 = Hmac<Sha256>;

/// Jeton aléatoire base64url (nonce des requêtes signées).
pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn mac(secret: &str) -> HmacSha256 {
    let key = URL_SAFE_NO_PAD.decode(secret).unwrap_or_default();
    HmacSha256::new_from_slice(&key).expect("HMAC accepte toute taille de clé")
}

pub fn sign(secret: &str, message: &str) -> String {
    let mut m = mac(secret);
    m.update(message.as_bytes());
    URL_SAFE_NO_PAD.encode(m.finalize().into_bytes())
}

/// Vérification à temps constant.
pub fn verify(secret: &str, message: &str, signature: &str) -> bool {
    let Ok(sig) = URL_SAFE_NO_PAD.decode(signature) else { return false };
    let mut m = mac(secret);
    m.update(message.as_bytes());
    m.verify_slice(&sig).is_ok()
}

/// Canal temps réel privé du PC, dérivé du secret.
pub fn topic_for(secret: &str) -> String {
    let digest = Sha256::digest(format!("jarvis-topic:{secret}").as_bytes());
    let hex: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!("jarvis-pc-{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mêmes vecteurs que services/worker/test/device-auth.test.ts.
    const SECRET: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    #[test]
    fn signatures_identiques_au_serveur() {
        assert_eq!(sign(SECRET, r#"{"device_id":"x","ts":1}"#), "caBPy66khQ_qHCOAbdbVpBPP9pl4r3J8iaIqUoIcSis");
        assert_eq!(sign(SECRET, r#"cmd:{"id":"c"}"#), "UPfyaQ7JoJYOgVJB6NLj-CDkzHgXfBZMJoMc5z68io8");
    }

    #[test]
    fn canal_identique_au_serveur() {
        assert_eq!(topic_for(SECRET), "jarvis-pc-bd3588be36955dd3327183d229e6db9f");
    }

    #[test]
    fn verification() {
        let s = sign(SECRET, "abc");
        assert!(verify(SECRET, "abc", &s));
        assert!(!verify(SECRET, "abd", &s));
        assert!(!verify(SECRET, "abc", "pas-une-signature"));
    }
}
