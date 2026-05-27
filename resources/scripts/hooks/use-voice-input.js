import {useState, useRef, useCallback} from '@wordpress/element';

/**
 * Voice-to-text for the composer, backed by the browser's Web Speech API.
 *
 * The public surface ({supported, listening, start, stop, toggle} + an
 * onResult callback) is deliberately backend-agnostic: a future server-side
 * implementation (record audio → POST to a Whisper endpoint → resolve text)
 * can replace the internals here without touching the mic button. onResult
 * fires with the running transcript (interim + final) so the caller can live-
 * update the input; isFinal marks when a phrase is committed.
 *
 * @param {Object}   [opts]
 * @param {Function} [opts.onResult] (transcript: string, isFinal: boolean) => void
 * @param {string}   [opts.lang]     BCP-47 language; defaults to the page/browser language.
 * @return {{supported: boolean, listening: boolean, start: Function, stop: Function, toggle: Function}} Voice control.
 */
export function useVoiceInput({onResult, lang} = {}) {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = !!SpeechRecognition;
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);

  const stop = useCallback(() => {
    try {
      recRef.current?.stop();
    } catch {
      // already stopped
    }
  }, []);

  const start = useCallback(() => {
    if (!SpeechRecognition || recRef.current) return;
    const rec = new SpeechRecognition();
    rec.lang =
      lang ||
      document.documentElement.lang ||
      navigator.language ||
      'en';
    rec.interimResults = true;
    rec.continuous = true;

    // Accumulate finalised phrases; append the in-progress interim each event
    // so the caller always gets the full session transcript.
    let finalText = '';
    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const seg = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += seg;
        else interim += seg;
      }
      onResult?.((finalText + interim).trim(), interim === '');
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
    if (recRef.current) stop();
    else start();
  }, [start, stop]);

  return {supported, listening, start, stop, toggle};
}
