import { useState, useRef, useCallback } from "@wordpress/element";

// ── Web Speech API surface ──────────────────────────────────
// lib.dom.d.ts ships SpeechRecognition / webkitSpeechRecognition on Window
// already, but the typings are spotty across browsers and TS releases. We
// cast through a narrow local shape for the bits we actually use rather than
// re-declaring the globals (which conflicts with the built-in types).

interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEvent {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionInstance;
}

function getSpeechRecognition(): SpeechRecognitionConstructor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

export interface UseVoiceInputOptions {
  /** (transcript, isFinal) — fires on every result event (interim and final). */
  onResult?: (transcript: string, isFinal: boolean) => void;
  /** BCP-47 language; defaults to the page/browser language. */
  lang?: string;
}

export interface UseVoiceInput {
  supported: boolean;
  listening: boolean;
  start: () => void;
  stop: () => void;
  toggle: () => void;
}

/**
 * Voice-to-text for the composer, backed by the browser's Web Speech API.
 *
 * The public surface is deliberately backend-agnostic: a future server-side
 * implementation (record audio → POST to a Whisper endpoint → resolve text)
 * can replace the internals here without touching the mic button. `onResult`
 * fires with the running transcript (interim + final) so the caller can live-
 * update the input; `isFinal` marks when a phrase is committed.
 * @param root0
 * @param root0.onResult
 * @param root0.lang
 */
export function useVoiceInput({
  onResult,
  lang,
}: UseVoiceInputOptions = {}): UseVoiceInput {
  const SpeechRecognition = getSpeechRecognition();
  const supported = !!SpeechRecognition;
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // already stopped
    }
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognition || recRef.current) {
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang =
      lang || document.documentElement.lang || navigator.language || "en";
    rec.interimResults = true;
    rec.continuous = true;

    // Accumulate finalised phrases; append the in-progress interim each event
    // so the caller always gets the full session transcript.
    let finalText = "";
    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const seg = event.results[i]![0].transcript;
        if (event.results[i]!.isFinal) {
          finalText += seg;
        } else {
          interim += seg;
        }
      }
      onResult?.((finalText + interim).trim(), interim === "");
    };
    // onend always fires (after a normal stop or an error), so reset there.
    rec.onend = () => {
      recRef.current = null;
      setListening(false);
    };

    recRef.current = rec;
    setListening(true);
    try {
      rec.start();
    } catch {
      recRef.current = null;
      setListening(false);
    }
  }, [SpeechRecognition, lang, onResult]);

  const toggle = useCallback(() => {
    if (recRef.current) {
      stop();
    } else {
      start();
    }
  }, [start, stop]);

  return { supported, listening, start, stop, toggle };
}
