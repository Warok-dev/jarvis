//! Détection locale du mot d'activation « Hey Jarvis » (modèles openWakeWord, inférence tract).
//!
//! Pipeline identique à openWakeWord (`AudioFeatures`) : audio 16 kHz par blocs de 80 ms
//! (1280 échantillons) → mel-spectrogramme (contexte de 480 échantillons, transformation x/10 + 2)
//! → embedding sur les 76 dernières trames mel → score du modèle sur les 16 derniers embeddings.
//! Rien ne quitte le PC : seul le score décide d'ouvrir Jarvis.

use std::collections::VecDeque;
use std::path::Path;
use tract_onnx::prelude::*;

pub const SAMPLE_RATE: u32 = 16_000;
/// Seuil par défaut (réglable dans settings.json : « wake_threshold »). openWakeWord conseille 0,5 ;
/// les voix de synthèse testées plafonnent vers 0,3 alors que les phrases ordinaires restent sous 0,01.
pub const DEFAULT_THRESHOLD: f32 = 0.3;
pub const CHUNK: usize = 1280; // 80 ms
const CONTEXT: usize = 160 * 3;
const MEL_BINS: usize = 32;
const MEL_WINDOW: usize = 76;
const MEL_MAX: usize = 10 * 97;
const EMBEDDING: usize = 96;
const FEATURES: usize = 16;
const FEATURE_MAX: usize = 120;
/// Les premiers scores, calculés sur des tampons encore « vides », sont ignorés (comme openWakeWord).
const WARMUP_CHUNKS: usize = 5;
/// Porte d'énergie : en dessous de ce niveau (RMS, échelle int16), un bloc est considéré silencieux.
const GATE_RMS: f32 = 150.0;
/// Après ~1 s de silence, la fenêtre de 76 trames ne contient plus que du silence : on peut
/// remplacer l'inférence par les valeurs précalculées du silence (quasi aucun calcul au repos).
const SILENT_CHUNKS_BEFORE_SKIP: usize = 12;

type Model = Arc<TypedRunnableModel>;

fn load(path: &Path, shape: &[usize]) -> TractResult<Model> {
    tract_onnx::onnx()
        .model_for_path(path)?
        .with_input_fact(0, f32::fact(shape).into())?
        .into_optimized()?
        .into_runnable()
}

pub struct Detector {
    mel: Model,
    embedding: Model,
    wakeword: Model,
    raw: VecDeque<i16>,
    pending: Vec<i16>,
    mel_frames: VecDeque<[f32; MEL_BINS]>,
    features: VecDeque<[f32; EMBEDDING]>,
    chunks: usize,
    silent_chunks: usize,
    silence_mel: Vec<[f32; MEL_BINS]>,
    silence_feature: [f32; EMBEDDING],
    /// Blocs réellement calculés (le reste a été court-circuité par la porte d'énergie).
    pub computed_chunks: usize,
}

impl Detector {
    /// `dir` contient melspectrogram.onnx, embedding_model.onnx et hey_jarvis_v0.1.onnx.
    pub fn new(dir: &Path) -> TractResult<Self> {
        let mut d = Detector {
            mel: load(&dir.join("melspectrogram.onnx"), &[1, CHUNK + CONTEXT])?,
            embedding: load(&dir.join("embedding_model.onnx"), &[1, MEL_WINDOW, MEL_BINS, 1])?,
            wakeword: load(&dir.join("hey_jarvis_v0.1.onnx"), &[1, FEATURES, EMBEDDING])?,
            raw: VecDeque::with_capacity(CHUNK + CONTEXT),
            pending: Vec::with_capacity(CHUNK),
            mel_frames: (0..MEL_WINDOW).map(|_| [1.0; MEL_BINS]).collect(),
            features: VecDeque::new(),
            chunks: 0,
            silent_chunks: 0,
            silence_mel: Vec::new(),
            silence_feature: [0.0; EMBEDDING],
            computed_chunks: 0,
        };
        // Valeurs du silence : mel d'un bloc nul, puis embedding d'une fenêtre entièrement silencieuse.
        d.silence_mel = d.mel_rows(&vec![0f32; CHUNK + CONTEXT])?;
        let window: Vec<f32> = d.silence_mel.iter().cycle().take(MEL_WINDOW).flatten().copied().collect();
        d.silence_feature = d.embed(window)?;
        // Comme openWakeWord : tampon d'embeddings initialisé avec du bruit faible (4 s).
        let mut seed = 0x1234_5678u32;
        let noise: Vec<i16> = (0..SAMPLE_RATE as usize * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((seed >> 16) as i32 % 2000 - 1000) as i16
            })
            .collect();
        for chunk in noise.chunks(CHUNK) {
            d.push_chunk(chunk)?;
        }
        d.chunks = 0;
        d.computed_chunks = 0;
        Ok(d)
    }

    fn mel_rows(&self, input: &[f32]) -> TractResult<Vec<[f32; MEL_BINS]>> {
        let tensor = tract_ndarray::Array2::from_shape_vec((1, CHUNK + CONTEXT), input.to_vec())?.into_tensor();
        let out = self.mel.run(tvec!(tensor.into()))?;
        let values: Vec<f32> = out[0].to_plain_array_view::<f32>()?.iter().copied().collect();
        Ok(values
            .chunks_exact(MEL_BINS)
            .map(|frame| {
                let mut row = [0f32; MEL_BINS];
                for (r, v) in row.iter_mut().zip(frame) {
                    *r = v / 10.0 + 2.0;
                }
                row
            })
            .collect())
    }

    fn embed(&self, window: Vec<f32>) -> TractResult<[f32; EMBEDDING]> {
        let tensor = tract_ndarray::Array4::from_shape_vec((1, MEL_WINDOW, MEL_BINS, 1), window)?.into_tensor();
        let out = self.embedding.run(tvec!(tensor.into()))?;
        let mut feature = [0f32; EMBEDDING];
        for (f, v) in feature.iter_mut().zip(out[0].to_plain_array_view::<f32>()?.iter()) {
            *f = *v;
        }
        Ok(feature)
    }

    fn push_mel(&mut self, rows: &[[f32; MEL_BINS]]) {
        for row in rows {
            if self.mel_frames.len() == MEL_MAX {
                self.mel_frames.pop_front();
            }
            self.mel_frames.push_back(*row);
        }
    }

    fn push_feature(&mut self, feature: [f32; EMBEDDING]) {
        if self.features.len() == FEATURE_MAX {
            self.features.pop_front();
        }
        self.features.push_back(feature);
    }

    /// Traite un bloc complet de 80 ms. Renvoie le score si le modèle a été évalué.
    fn push_chunk(&mut self, chunk: &[i16]) -> TractResult<Option<f32>> {
        for &s in chunk {
            if self.raw.len() == CHUNK + CONTEXT {
                self.raw.pop_front();
            }
            self.raw.push_back(s);
        }
        self.chunks += 1;

        let rms = (chunk.iter().map(|&s| (s as f32) * (s as f32)).sum::<f32>() / chunk.len() as f32).sqrt();
        self.silent_chunks = if rms < GATE_RMS { self.silent_chunks + 1 } else { 0 };
        if self.silent_chunks > SILENT_CHUNKS_BEFORE_SKIP {
            let rows = self.silence_mel.clone();
            self.push_mel(&rows);
            self.push_feature(self.silence_feature);
            return Ok(None);
        }
        self.computed_chunks += 1;

        // Mel-spectrogramme du dernier bloc avec 30 ms de contexte (zéros au tout début).
        let mut input = vec![0f32; CHUNK + CONTEXT];
        let offset = input.len() - self.raw.len();
        for (i, &s) in self.raw.iter().enumerate() {
            input[offset + i] = s as f32;
        }
        let rows = self.mel_rows(&input)?;
        self.push_mel(&rows);

        // Embedding des 76 dernières trames.
        let window: Vec<f32> = self.mel_frames.iter().skip(self.mel_frames.len() - MEL_WINDOW).flatten().copied().collect();
        let feature = self.embed(window)?;
        self.push_feature(feature);
        if self.features.len() < FEATURES {
            return Ok(None);
        }

        let last: Vec<f32> = self.features.iter().skip(self.features.len() - FEATURES).flatten().copied().collect();
        let tensor = tract_ndarray::Array3::from_shape_vec((1, FEATURES, EMBEDDING), last)?.into_tensor();
        let score = self.wakeword.run(tvec!(tensor.into()))?;
        let value = score[0].to_plain_array_view::<f32>()?.iter().copied().next().unwrap_or(0.0);
        Ok(if self.chunks > WARMUP_CHUNKS { Some(value) } else { None })
    }

    /// Ajoute des échantillons (16 kHz, mono) ; renvoie le meilleur score des blocs complétés.
    pub fn process(&mut self, samples: &[i16]) -> TractResult<Option<f32>> {
        self.pending.extend_from_slice(samples);
        let mut best: Option<f32> = None;
        while self.pending.len() >= CHUNK {
            let chunk: Vec<i16> = self.pending.drain(..CHUNK).collect();
            if let Some(s) = self.push_chunk(&chunk)? {
                best = Some(best.map_or(s, |b: f32| b.max(s)));
            }
        }
        Ok(best)
    }
}

/// Lecture d'un WAV PCM 16 bits mono (tests).
#[cfg(test)]
pub fn read_wav_mono16(path: &Path) -> Result<(u32, Vec<i16>), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("pas un fichier WAV".into());
    }
    let (mut pos, mut rate, mut data) = (12usize, 0u32, None);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes(bytes[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &bytes[pos + 8..(pos + 8 + size).min(bytes.len())];
        if id == b"fmt " {
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            if channels != 1 || bits != 16 {
                return Err("WAV attendu : mono 16 bits".into());
            }
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
        } else if id == b"data" {
            data = Some(body.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect());
        }
        pos += 8 + size + (size & 1);
    }
    Ok((rate, data.ok_or("pas de données audio")?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn max_score(file: &str) -> f32 {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/wakeword");
        let (rate, samples) = read_wav_mono16(&dir.join("test").join(file)).unwrap();
        assert_eq!(rate, SAMPLE_RATE);
        let mut d = Detector::new(&dir).unwrap();
        // Envoi par petits paquets, comme un micro (20 ms).
        let mut best = 0f32;
        for part in samples.chunks(320) {
            if let Some(s) = d.process(part).unwrap() {
                best = best.max(s);
            }
        }
        // Un peu de silence à la fin pour laisser le dernier mot passer dans la fenêtre.
        if let Some(s) = d.process(&vec![0i16; CHUNK * 10]).unwrap() {
            best = best.max(s);
        }
        best
    }

    // Les voix de synthèse Windows (Zira, David, Hortense) sont plus robotiques qu'une vraie voix :
    // on vérifie que le pipeline sépare nettement « Hey Jarvis » du reste, pas un seuil précis.
    #[test]
    fn detecte_hey_jarvis_sans_faux_positif() {
        let mut lines = Vec::new();
        let (mut min_pos, mut max_neg) = (f32::MAX, 0f32);
        for (file, expected) in [
            ("pos_hey_jarvis_1.wav", true),
            ("pos_hey_jarvis_2.wav", true),
            ("pos_hey_jarvis_3.wav", true),
            ("neg_hey_travis.wav", false),
            ("neg_fr_1.wav", false),
            ("neg_fr_2.wav", false),
        ] {
            let score = max_score(file);
            if expected {
                min_pos = min_pos.min(score);
            } else {
                max_neg = max_neg.max(score);
            }
            lines.push(format!("{file}: {score:.3}"));
        }
        let report = lines.join("\n");
        println!("{report}");
        assert!(min_pos > 0.15, "« Hey Jarvis » trop faible\n{report}");
        assert!(max_neg < 0.05, "faux positif\n{report}");
        assert!(min_pos > 20.0 * max_neg, "séparation insuffisante\n{report}");
    }

    #[test]
    fn cout_par_bloc() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/wakeword");
        let mut d = Detector::new(&dir).unwrap();
        // Bruit de parole simulé (porte ouverte) puis 8 s de silence (porte fermée).
        let mut seed = 7u32;
        let loud: Vec<i16> = (0..CHUNK * 50).map(|_| { seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345); ((seed >> 16) % 8000) as i16 - 4000 }).collect();
        let t = std::time::Instant::now();
        d.process(&loud).unwrap();
        let active = t.elapsed().as_secs_f64() * 1000.0 / 50.0;
        let before = d.computed_chunks;
        let t = std::time::Instant::now();
        d.process(&vec![0i16; CHUNK * 100]).unwrap();
        let quiet = t.elapsed().as_secs_f64() * 1000.0 / 100.0;
        println!("coût avec son : {active:.2} ms/bloc ({:.1} % d'un cœur)", active / 80.0 * 100.0);
        println!("coût en silence : {quiet:.3} ms/bloc ({:.2} % d'un cœur), {} blocs calculés sur 100", quiet / 80.0 * 100.0, d.computed_chunks - before);
        // Seuil de temps seulement en release (le mode debug de tract est beaucoup plus lent).
        if !cfg!(debug_assertions) {
            assert!(active < 40.0);
        }
        assert!(d.computed_chunks - before <= SILENT_CHUNKS_BEFORE_SKIP + 1);
    }
}
