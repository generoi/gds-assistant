/**
 * MicButton — voice dictation + voice-mode (auto-send) for the composer.
 *
 * Uses the Web Speech API via {@link useVoiceInput} to stream interim
 * transcripts into the active composer. Coordinates with TTS so the mic isn't
 * listening to the assistant's own voice (Skype-style half-duplex), and
 * supports a "Voice mode" that auto-sends after a brief silence.
 *
 * Rendered inside the composer toolbar; returns `null` on browsers without
 * Web Speech support.
 */

import { useComposerRuntime, useThreadRuntime } from "@assistant-ui/react";
import { useCallback, useEffect, useRef, useState } from "@wordpress/element";

import { useVoiceInput } from "../hooks/use-voice-input";
import {
  TTS_EVENTS,
  cancelTts,
  ttsSupported,
  useTtsEnabled,
  useVoiceMode,
} from "../hooks/use-tts";

// Pick the initial dictation language: a remembered choice, else the page
// language (matched against the available codes), else the first available.
function pickInitialVoiceLang(langs) {
  if (!langs.length) {
    return undefined;
  }
  const codes = langs.map((l) => l.code);
  try {
    const saved = localStorage.getItem("gds-assistant-voice-lang");
    if (saved && codes.includes(saved)) {
      return saved;
    }
  } catch {
    // storage unavailable
  }
  const page = (
    document.documentElement.lang ||
    navigator.language ||
    ""
  ).toLowerCase();
  const exact = codes.find((c) => c.toLowerCase() === page);
  if (exact) {
    return exact;
  }
  const primary = page.split("-")[0];
  return (
    codes.find((c) => c.toLowerCase().split("-")[0] === primary) || codes[0]
  );
}

export function MicButton() {
  const composer = useComposerRuntime();
  // The text already in the composer when dictation starts — the transcript is
  // appended to it so we never clobber what the user typed.
  const baseRef = useRef("");
  // Web Speech can't auto-detect language; offer the site's languages (from
  // Polylang via the localized config) so a user can dictate in one that
  // differs from the admin UI language.
  const langs = window.gdsAssistant?.voiceLanguages || [];
  const [lang, setLang] = useState(() => pickInitialVoiceLang(langs));
  const [langOpen, setLangOpen] = useState(false);
  const wrapRef = useRef(null);
  const [readAloud, setReadAloud] = useTtsEnabled();
  const [voiceMode, setVoiceMode] = useVoiceMode();
  const ttsAvail = ttsSupported();
  // Silence-based auto-send timer for Voice mode. ref so it isn't recreated
  // every render and so its handlers see the freshest composer/threadRuntime
  // values.
  const silenceTimerRef = useRef(null);
  const voiceModeRef = useRef(voiceMode);
  const hasFinalRef = useRef(false);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  const { supported, listening, start, stop } = useVoiceInput({
    lang,
    onResult: (transcript, isFinal) => {
      const base = baseRef.current;
      const sep = base && !/\s$/.test(base) ? " " : "";
      composer.setText(base + sep + transcript);

      if (isFinal) {
        hasFinalRef.current = true;
      }

      // Voice mode: any result event (interim or final) resets the silence
      // window; if no further events arrive within SEND_AFTER_SILENCE_MS the
      // composer auto-sends. We only arm after we've seen at least one final
      // so the user has to actually say something.
      if (voiceModeRef.current) {
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
        silenceTimerRef.current = setTimeout(() => {
          silenceTimerRef.current = null;
          if (!hasFinalRef.current) {
            return;
          }
          const text = composer.getState?.()?.text || "";
          if (!text.trim()) {
            return;
          }
          hasFinalRef.current = false;
          baseRef.current = "";
          composer.send?.();
        }, 1500);
      }
    },
  });

  // Close the language popover on an outside click.
  useEffect(() => {
    if (!langOpen) {
      return undefined;
    }
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setLangOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [langOpen]);

  // Skype-style half-duplex: while the user "wants the mic on" we shuttle it
  // off during the AI's turn (so we don't transcribe its own voice back in)
  // and turn it back on once the AI is done. The user's intent flips only on
  // explicit mic taps — auto pause/resume keeps it consistent across replies.
  const intendsRef = useRef(false);
  const listeningRef = useRef(false);
  const readAloudRef = useRef(readAloud);
  const threadRuntime = useThreadRuntime();
  useEffect(() => {
    listeningRef.current = listening;
  }, [listening]);
  useEffect(() => {
    readAloudRef.current = readAloud;
  }, [readAloud]);

  const tryRestart = useCallback(() => {
    if (!intendsRef.current) {
      return;
    }
    if (listeningRef.current) {
      return;
    }
    // Don't restart while TTS is still draining (cancel/end race).
    if (window.speechSynthesis?.speaking || window.speechSynthesis?.pending) {
      return;
    }
    baseRef.current = composer.getState?.()?.text || "";
    start();
  }, [start, composer]);

  // TTS start → drop the mic; TTS end → bring it back if the user still wants it.
  useEffect(() => {
    if (!supported) {
      return undefined;
    }
    const onTtsStart = () => {
      if (listeningRef.current) {
        stop();
      }
    };
    const onTtsEnd = () => {
      // Small delay so the cancel-drained queue settles before we re-listen.
      setTimeout(tryRestart, 80);
    };
    window.addEventListener(TTS_EVENTS.start, onTtsStart);
    window.addEventListener(TTS_EVENTS.end, onTtsEnd);
    return () => {
      window.removeEventListener(TTS_EVENTS.start, onTtsStart);
      window.removeEventListener(TTS_EVENTS.end, onTtsEnd);
    };
  }, [supported, stop, tryRestart]);

  // Mute the mic for the assistant's turn (so a user mid-sentence doesn't get
  // recorded talking over the run), and resume on turn-end when read-aloud is
  // OFF (when it's ON, the TTS_END handler above takes care of resuming).
  useEffect(() => {
    if (!supported) {
      return undefined;
    }
    let prevRunning = false;
    return threadRuntime.subscribe(() => {
      const running = !!threadRuntime.getState?.()?.isRunning;
      if (running && !prevRunning && listeningRef.current) {
        stop();
      }
      if (!running && prevRunning && !readAloudRef.current) {
        setTimeout(tryRestart, 80);
      }
      prevRunning = running;
    });
  }, [supported, stop, tryRestart, threadRuntime]);

  if (!supported) {
    return null;
  }

  const handle = () => {
    if (listening) {
      intendsRef.current = false;
      // Explicit stop overrides any pending auto-send timer.
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
      }
      stop();
      return;
    }
    intendsRef.current = true;
    hasFinalRef.current = false;
    // User taking a turn — shut the AI up so we don't transcribe its voice.
    cancelTts();
    baseRef.current = composer.getState?.()?.text || "";
    start();
  };

  const choose = (code) => {
    setLang(code);
    setLangOpen(false);
    try {
      localStorage.setItem("gds-assistant-voice-lang", code);
    } catch {
      // storage unavailable
    }
  };

  // Chevron + popover are useful when there's >1 dictation language OR when
  // TTS is supported (so the user can flip the read-aloud toggle); hide the
  // chevron only when neither is true.
  const showPopoverToggle = langs.length > 1 || ttsAvail;

  return (
    <div className="gds-assistant__voice" ref={wrapRef}>
      {/* Popover opens upward (composer is pinned to the panel bottom). */}
      {showPopoverToggle && langOpen && (
        <div className="gds-assistant__voice-langs" role="menu">
          {langs.length > 1 &&
            langs.map((l) => (
              <button
                key={l.code}
                type="button"
                role="menuitemradio"
                aria-checked={l.code === lang}
                className={`gds-assistant__voice-langs-item${
                  l.code === lang ? " is-active" : ""
                }`}
                onClick={() => choose(l.code)}
              >
                <span>{l.name}</span>
                {l.code === lang && (
                  <span
                    className="gds-assistant__voice-langs-check"
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                )}
              </button>
            ))}
          {ttsAvail && langs.length > 1 && (
            <div
              className="gds-assistant__voice-langs-sep"
              aria-hidden="true"
            />
          )}
          {ttsAvail && (
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={readAloud}
              className={`gds-assistant__voice-langs-item gds-assistant__voice-langs-toggle${
                readAloud ? " is-active" : ""
              }`}
              onClick={() => setReadAloud(!readAloud)}
              title="Read assistant replies aloud using Web Speech"
            >
              <span>Read replies aloud</span>
              <span
                className={`gds-assistant__voice-switch${
                  readAloud ? " is-on" : ""
                }`}
                aria-hidden="true"
              >
                <span className="gds-assistant__voice-switch-knob" />
              </span>
            </button>
          )}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={voiceMode}
            className={`gds-assistant__voice-langs-item gds-assistant__voice-langs-toggle${
              voiceMode ? " is-active" : ""
            }`}
            onClick={() => setVoiceMode(!voiceMode)}
            title="Auto-send the message after a short pause when dictating"
          >
            <span>Voice mode (auto-send)</span>
            <span
              className={`gds-assistant__voice-switch${
                voiceMode ? " is-on" : ""
              }`}
              aria-hidden="true"
            >
              <span className="gds-assistant__voice-switch-knob" />
            </span>
          </button>
        </div>
      )}
      <button
        type="button"
        className={`gds-assistant__mic${
          listening ? " gds-assistant__mic--listening" : ""
        }`}
        onClick={handle}
        title={listening ? "Stop dictation" : "Dictate (voice to text)"}
        aria-pressed={listening}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      {showPopoverToggle && (
        <button
          type="button"
          className="gds-assistant__voice-lang"
          onClick={() => setLangOpen((v) => !v)}
          disabled={listening}
          title={
            langs.length > 1
              ? "Voice settings (dictation language + read aloud)"
              : "Voice settings"
          }
          aria-haspopup="menu"
          aria-expanded={langOpen}
        >
          <svg
            className="gds-assistant__voice-chevron"
            width="9"
            height="9"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
    </div>
  );
}
