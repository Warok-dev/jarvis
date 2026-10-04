// Voix dans le navigateur : reconnaissance (Web Speech API) et synthèse (speechSynthesis).
// Aucune clé ni serveur : tout est fourni par le système (Siri/iOS, Chrome, Edge…).

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

const Ctor = (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
  .SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export const canListen = Boolean(Ctor);
export const canSpeak = "speechSynthesis" in window;

export interface ListenHandle {
  stop(): void;
}

// Écoute une phrase. onPartial reçoit le texte au fil de l'eau, onFinal la phrase complète.
export function listen(opts: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): ListenHandle | null {
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "fr-CA";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "";
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onPartial((finalText + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    opts.onError(e.error === "not-allowed" ? "Micro refusé : autorise-le dans les réglages." : `Micro : ${e.error}`);
  };
  rec.onend = () => {
    if (finalText.trim()) opts.onFinal(finalText.trim());
    opts.onEnd();
  };
  rec.start();
  return { stop: () => rec.stop() };
}

let voice: SpeechSynthesisVoice | null = null;
function pickVoice(): SpeechSynthesisVoice | null {
  if (voice) return voice;
  const voices = speechSynthesis.getVoices();
  voice = voices.find((v) => v.lang === "fr-CA") ?? voices.find((v) => v.lang.startsWith("fr")) ?? null;
  return voice;
}
if (canSpeak) speechSynthesis.onvoiceschanged = () => { voice = null; pickVoice(); };

// iOS n'autorise la synthèse qu'après un geste : on l'« amorce » au toucher du micro.
export function unlockSpeech(): void {
  if (!canSpeak) return;
  const u = new SpeechSynthesisUtterance("");
  u.volume = 0;
  speechSynthesis.speak(u);
}

export function speak(text: string, onDone?: () => void): void {
  if (!canSpeak) return onDone?.();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "fr-CA";
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.05;
  u.onend = () => onDone?.();
  u.onerror = () => onDone?.();
  speechSynthesis.speak(u);
}

export function stopSpeaking(): void {
  if (canSpeak) speechSynthesis.cancel();
}
