import { useEffect, useRef, useState, type FormEvent } from "react";
import { supabase } from "../lib/supabase";
import { currentDevice } from "../lib/device";
import { canListen, listen, speak, stopSpeaking, unlockSpeech, type ListenHandle } from "../lib/voice";

type Turn = { role: "user" | "assistant"; content: string };
type Phase = "idle" | "listening" | "thinking" | "speaking";

async function ask(messages: Turn[]): Promise<string> {
  const { data, error } = await supabase.functions.invoke("assistant", { body: { messages, device: currentDevice() } });
  if (error) {
    // Les erreurs prévues renvoient quand même une phrase à dire.
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    return body?.reply ?? "Je n'arrive pas à joindre le serveur.";
  }
  return (data as { reply: string }).reply;
}

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [partial, setPartial] = useState("");
  const [draft, setDraft] = useState("");
  const [voiceOn, setVoiceOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const listening = useRef<ListenHandle | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns, partial, phase]);
  useEffect(() => () => { listening.current?.stop(); stopSpeaking(); }, []);

  async function send(text: string, spoken: boolean) {
    const next = [...turns, { role: "user" as const, content: text }];
    setTurns(next);
    setPhase("thinking");
    const reply = await ask(next);
    setTurns([...next, { role: "assistant", content: reply }]);
    if (spoken && voiceOn) {
      setPhase("speaking");
      speak(reply, () => setPhase("idle"));
    } else setPhase("idle");
  }

  function startListening() {
    setError(null);
    stopSpeaking();
    unlockSpeech();
    setOpen(true);
    setPartial("");
    setPhase("listening");
    listening.current = listen({
      onPartial: setPartial,
      onFinal: (text) => { setPartial(""); void send(text, true); },
      onError: (m) => setError(m),
      onEnd: () => { listening.current = null; setPhase((p) => (p === "listening" ? "idle" : p)); },
    });
  }

  function onMic() {
    if (phase === "listening") return listening.current?.stop();
    if (phase === "speaking") { stopSpeaking(); return setPhase("idle"); }
    if (phase === "thinking") return;
    startListening();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || phase === "thinking") return;
    setDraft("");
    unlockSpeech();
    void send(text, false);
  }

  const micLabel = { idle: "Parler à Jarvis", listening: "Arrêter l'écoute", thinking: "Jarvis réfléchit", speaking: "Couper la voix" }[phase];

  return (
    <>
      {open && (
        <section className="assistant-panel" aria-label="Conversation avec Jarvis">
          <header className="assistant-head">
            <strong>Jarvis</strong>
            <div className="assistant-tools">
              <button className="ghost" onClick={() => { setVoiceOn((v) => !v); stopSpeaking(); }} aria-pressed={voiceOn}>
                {voiceOn ? "Voix : oui" : "Voix : non"}
              </button>
              <button className="ghost" onClick={() => { setOpen(false); stopSpeaking(); listening.current?.stop(); }}>Fermer</button>
            </div>
          </header>
          <div className="assistant-log" aria-live="polite">
            {!turns.length && !partial && (
              <p className="muted hint">
                Exemples : « Qu'est-ce que j'ai à rendre cette semaine ? », « J'ai fini le lab 1 d'ELG », « Je commence le devoir 2 ».
              </p>
            )}
            {turns.map((t, i) => <p key={i} className={`bubble ${t.role}`}>{t.content}</p>)}
            {partial && <p className="bubble user partial">{partial}</p>}
            {phase === "thinking" && <p className="bubble assistant typing" aria-label="Jarvis réfléchit"><span /><span /><span /></p>}
            {error && <p className="error">{error}</p>}
            <div ref={bottom} />
          </div>
          <form className="assistant-input" onSubmit={onSubmit}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={canListen ? "Écrire à Jarvis…" : "Écrire à Jarvis (dictée : touche micro du clavier)"}
              enterKeyHint="send"
            />
            <button type="submit" className="primary" disabled={!draft.trim() || phase === "thinking"}>Envoyer</button>
          </form>
        </section>
      )}

      {canListen ? (
        <button className={`mic mic-${phase}`} onClick={onMic} aria-label={micLabel} title={micLabel}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" /></svg>
        </button>
      ) : (
        !open && <button className="mic" onClick={() => setOpen(true)} aria-label="Écrire à Jarvis">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H7l-3 3V4Z" /></svg>
        </button>
      )}
    </>
  );
}
