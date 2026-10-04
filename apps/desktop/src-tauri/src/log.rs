//! Journal fichier minimal (%APPDATA%\dev.warok.jarvis\jarvis.log).
//! Pas d'eprintln! : sans console, écrire sur une sortie fermée peut faire paniquer l'app.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

const MAX_BYTES: u64 = 512 * 1024;
static FILE: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = FILE.set(dir.join("jarvis.log"));
}

pub fn line(msg: &str) {
    let Some(path) = FILE.get() else { return };
    // Rotation simple : au-delà de 512 Ko, l'ancien journal devient jarvis.log.old.
    if std::fs::metadata(path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    }
}

#[macro_export]
macro_rules! log {
    ($($arg:tt)*) => { $crate::log::line(&format!($($arg)*)) };
}
