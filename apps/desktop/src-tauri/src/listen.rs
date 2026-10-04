//! Écoute du micro pour le mot d'activation.
//!
//! Le callback audio ne fait que convertir (mono, 16 kHz) et transmettre ; la détection tourne
//! dans un thread dédié. Désactivé par défaut : l'utilisateur l'active dans le menu de Jarvis.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use crate::wakeword::{Detector, CHUNK, SAMPLE_RATE};

/// Après une détection, on ignore le micro 2 s (pas de double déclenchement).
const REFRACTORY_CHUNKS: usize = 25;

/// Rééchantillonnage vers 16 kHz : moyenne glissante (anti-repliement grossier) puis interpolation linéaire.
pub struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
    window: usize,
    history: Vec<f32>,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        let step = input_rate as f64 / SAMPLE_RATE as f64;
        Resampler { step, pos: 0.0, prev: 0.0, window: step.ceil().max(1.0) as usize, history: Vec::new() }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<i16>) {
        if input.is_empty() {
            return;
        }
        // Filtre passe-bas simple : moyenne sur `window` échantillons.
        let filtered: Vec<f32> = if self.window > 1 {
            self.history.extend_from_slice(input);
            let start = self.history.len() - input.len();
            let f = (start..self.history.len())
                .map(|i| {
                    let lo = i.saturating_sub(self.window - 1);
                    self.history[lo..=i].iter().sum::<f32>() / (i - lo + 1) as f32
                })
                .collect();
            let keep = self.window.min(self.history.len());
            self.history.drain(..self.history.len() - keep);
            f
        } else {
            input.to_vec()
        };
        // `pos` est la position (dans ce paquet) du prochain échantillon de sortie ; -1 = `prev`.
        let n = filtered.len() as f64;
        // Strictement inférieur : il faut l'échantillon suivant pour interpoler (sinon : paquet suivant).
        while self.pos < n - 1.0 {
            let i = self.pos.floor();
            let frac = (self.pos - i) as f32;
            let s0 = if i < 0.0 { self.prev } else { filtered[i as usize] };
            let s1 = filtered[(i + 1.0).max(0.0) as usize];
            let v = s0 + (s1 - s0) * frac;
            out.push((v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
            self.pos += self.step;
        }
        self.pos -= n;
        self.prev = *filtered.last().unwrap();
    }
}

pub struct Listener {
    stop: Arc<AtomicBool>,
}

impl Listener {
    /// Démarre l'écoute. `on_wake` est appelé (depuis le thread d'écoute) à chaque détection.
    pub fn start(models: PathBuf, threshold: f32, on_wake: impl Fn(f32) + Send + 'static) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();

        std::thread::Builder::new()
            .name("jarvis-ecoute".into())
            .spawn(move || {
                let mut detector = match Detector::new(&models) {
                    Ok(d) => d,
                    Err(e) => return ready_tx.send(Err(format!("modèles : {e}"))).unwrap_or(()),
                };
                let (tx, rx) = mpsc::sync_channel::<Vec<i16>>(64);
                let stream = match open_stream(tx) {
                    Ok(s) => s,
                    Err(e) => return ready_tx.send(Err(e)).unwrap_or(()),
                };
                let _ = ready_tx.send(Ok(()));
                let mut refractory = 0usize;
                while !stop_thread.load(Ordering::Relaxed) {
                    let Ok(samples) = rx.recv_timeout(Duration::from_millis(500)) else { continue };
                    if refractory > 0 {
                        refractory = refractory.saturating_sub(samples.len() / CHUNK + 1);
                        continue;
                    }
                    match detector.process(&samples) {
                        Ok(Some(score)) if score >= threshold => {
                            refractory = REFRACTORY_CHUNKS;
                            on_wake(score);
                        }
                        Ok(_) => {}
                        Err(e) => crate::log!("écoute : {e}"),
                    }
                }
                drop(stream);
            })
            .map_err(|e| e.to_string())?;

        match ready_rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(())) => Ok(Listener { stop }),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("le micro ne répond pas".into()),
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn open_stream(tx: mpsc::SyncSender<Vec<i16>>) -> Result<cpal::Stream, String> {
    let device = cpal::default_host().default_input_device().ok_or("aucun micro trouvé")?;
    let config = device.default_input_config().map_err(|e| e.to_string())?;
    let channels = config.channels() as usize;
    if channels == 0 {
        return Err("le micro n'annonce aucun canal audio".into());
    }
    let mut resampler = Resampler::new(config.sample_rate().0);
    crate::log!(
        "micro : {} ({} Hz, {} canal/canaux, {:?})",
        device.name().unwrap_or_default(),
        config.sample_rate().0,
        channels,
        config.sample_format()
    );
    let err = |e| crate::log!("micro : {e}");
    let mut send = move |mono: Vec<f32>| {
        let mut out = Vec::with_capacity(mono.len() / 2);
        resampler.push(&mono, &mut out);
        // Si le traitement prend du retard, on jette plutôt que de bloquer le pilote audio.
        let _ = tx.try_send(out);
    };
    let mix = move |frame: &[f32]| frame.iter().sum::<f32>() / frame.len() as f32;
    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &config.into(),
            move |data: &[f32], _| send(data.chunks(channels).map(mix).collect()),
            err,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            &config.into(),
            move |data: &[i16], _| {
                send(data.chunks(channels).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / f.len() as f32).collect())
            },
            err,
            None,
        ),
        other => return Err(format!("format audio non géré : {other:?}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, freq: f32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize).map(|i| (i as f32 * freq * std::f32::consts::TAU / rate as f32).sin() * 0.5).collect()
    }

    // Compte les passages par zéro montants : ~ fréquence × durée.
    fn rising_zero_crossings(s: &[i16]) -> usize {
        s.windows(2).filter(|w| w[0] < 0 && w[1] >= 0).count()
    }

    #[test]
    fn reechantillonne_48k_et_44k_vers_16k() {
        for rate in [48_000, 44_100, 16_000] {
            let input = sine(rate, 440.0, 1.0);
            let mut r = Resampler::new(rate);
            let mut out = Vec::new();
            // Paquets irréguliers, comme un pilote audio.
            for part in input.chunks(rate as usize / 100 + 7) {
                r.push(part, &mut out);
            }
            assert!((out.len() as i32 - 16_000).abs() <= 2, "{rate} Hz → {} échantillons", out.len());
            let crossings = rising_zero_crossings(&out) as i32;
            assert!((crossings - 440).abs() <= 2, "{rate} Hz → {crossings} périodes");
        }
    }
}
