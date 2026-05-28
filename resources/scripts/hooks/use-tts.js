/**
 * Text-to-speech for assistant replies — Web Speech API (no network call,
 * no extra dependency). The on/off preference is persisted in localStorage
 * and lives in the existing language popover next to the dictation mic, so
 * the same dropdown drives both directions (user → assistant via mic,
 * assistant → user via speak-aloud).
 */

import {useEffect, useState} from '@wordpress/element';

const ENABLED_KEY = 'gds-assistant-read-aloud';
const LANG_KEY = 'gds-assistant-voice-lang';
const PREF_EVENT = 'gds-assistant-tts-pref';
// Default Web Speech rate is 1.0; macOS system voices feel sluggish at that.
// 1.35 is noticeably snappier without sounding chipmunked — still well below
// the typical comprehension ceiling of ~1.7x.
const TTS_RATE = 1.35;
// Events the mic listens for so it can pause dictation while the AI is
// speaking — otherwise the AI's own voice goes through the mic and back into
// the composer as user input.
const TTS_START_EVENT = 'gds-assistant-tts-start';
const TTS_END_EVENT = 'gds-assistant-tts-end';
export const TTS_EVENTS = {start: TTS_START_EVENT, end: TTS_END_EVENT};

export function ttsSupported() {
  return (
    typeof window !== 'undefined' &&
    typeof window.speechSynthesis !== 'undefined' &&
    typeof window.SpeechSynthesisUtterance !== 'undefined'
  );
}

function readPref() {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

function writePref(value) {
  try {
    if (value) {
      localStorage.setItem(ENABLED_KEY, '1');
    } else {
      localStorage.removeItem(ENABLED_KEY);
    }
  } catch {
    // storage unavailable — fall through, state is still in memory.
  }
  // localStorage's `storage` event only fires in *other* tabs. Use a custom
  // event for same-tab sync so a toggle in one component updates listeners
  // elsewhere (mic popover ↔ playback controller) immediately.
  window.dispatchEvent(new CustomEvent(PREF_EVENT));
}

/** React hook returning [enabled, setEnabled] that survives full-page reloads. */
export function useTtsEnabled() {
  const [enabled, setEnabledState] = useState(readPref);

  useEffect(() => {
    const sync = () => setEnabledState(readPref());
    window.addEventListener('storage', sync);
    window.addEventListener(PREF_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(PREF_EVENT, sync);
    };
  }, []);

  const setEnabled = (value) => {
    const next = !!value;
    writePref(next);
    setEnabledState(next);
    // Turning the toggle off mid-speech should silence it immediately.
    if (!next) cancelTts();
  };

  return [enabled, setEnabled];
}

/** Read the currently-picked dictation/TTS language from localStorage, if any. */
export function readVoiceLang() {
  try {
    return localStorage.getItem(LANG_KEY) || '';
  } catch {
    return '';
  }
}

/**
 * Strip Markdown noise that would be pronounced literally (asterisks, backticks,
 * link syntax, etc.). The streamdown-rendered chat shows formatted text — the
 * TTS read-aloud should match what the user *hears*, not the raw markdown.
 */
export function cleanForSpeech(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull readable text out of an assistant message. Skips tool calls / results —
 * they're machinery, not the answer the user wants spoken.
 */
export function extractAssistantText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

/**
 * Resolve once the browser has actually loaded its voice list. In Chrome
 * `getVoices()` returns [] until the `voiceschanged` event fires; without
 * this gate the first `speak()` may pick no voice and silently no-op.
 */
function voicesReady() {
  if (!ttsSupported()) return Promise.resolve([]);
  const synth = window.speechSynthesis;
  const have = synth.getVoices?.() || [];
  if (have.length) return Promise.resolve(have);
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.('voiceschanged', done);
      resolve(synth.getVoices?.() || []);
    };
    synth.addEventListener?.('voiceschanged', done);
    // Safari never fires `voiceschanged`; cap the wait.
    setTimeout(done, 800);
  });
}

/** Pick the best installed voice for a BCP-47 lang code. */
function pickVoice(voices, lang) {
  if (!lang || !voices?.length) return null;
  const want = lang.toLowerCase();
  const primary = want.split('-')[0];
  return (
    voices.find((v) => v.lang?.toLowerCase() === want) ||
    voices.find((v) => v.lang?.toLowerCase().split('-')[0] === primary) ||
    null
  );
}

function queueUtterances(chunks, lang) {
  const synth = window.speechSynthesis;
  const voices = synth.getVoices?.() || [];
  const voice = pickVoice(voices, lang);
  // Only fire start/end events on the FIRST and LAST utterances so listeners
  // (the mic auto-pause) see one start and one end per AI reply, even though
  // the reply is split into multiple speak() calls internally.
  let firstStartFired = false;
  let endsRemaining = chunks.length;
  const fireStart = () => {
    if (firstStartFired) return;
    firstStartFired = true;
    window.dispatchEvent(new CustomEvent(TTS_START_EVENT));
  };
  const tickEnd = () => {
    endsRemaining -= 1;
    if (endsRemaining <= 0) {
      window.dispatchEvent(new CustomEvent(TTS_END_EVENT));
    }
  };
  for (const chunk of chunks) {
    const u = new window.SpeechSynthesisUtterance(chunk);
    if (lang) u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = TTS_RATE;
    u.onstart = fireStart;
    u.onend = tickEnd;
    u.onerror = tickEnd;
    synth.speak(u);
  }
}

/** Start speaking. Cancels any in-flight utterance first. */
export function speak(text, lang) {
  if (!ttsSupported()) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const chunks = chunkForUtterance(clean, 220);
  const synth = window.speechSynthesis;
  // Chrome bug: `cancel()` runs asynchronously, so a `speak()` called in the
  // same tick can be swallowed by the still-draining cancel queue. Defer the
  // speak past the next tick when there's anything to cancel, and gate on
  // voices having loaded so the first utterance after page load isn't a
  // no-op (Chrome returns [] from getVoices() until `voiceschanged` fires).
  const launch = () => queueUtterances(chunks, lang);
  const needCancel = synth.speaking || synth.pending;
  if (needCancel) synth.cancel();
  voicesReady().then(() => {
    if (needCancel) {
      setTimeout(launch, 50);
    } else {
      launch();
    }
  });
}

export function cancelTts() {
  if (!ttsSupported()) return;
  const synth = window.speechSynthesis;
  const wasActive = synth.speaking || synth.pending;
  try {
    synth.cancel();
  } catch {
    // ignore
  }
  // Make sure any mic-pause listener releases when we stop early — chunked
  // utterance `onend` may not all fire after a hard cancel.
  if (wasActive) {
    window.dispatchEvent(new CustomEvent(TTS_END_EVENT));
  }
}

function chunkForUtterance(text, target) {
  if (text.length <= target) return [text];
  // Split into sentences first, then re-pack into ≤target-sized chunks.
  const sentences = text.split(/(?<=[.!?。！？])\s+/);
  const chunks = [];
  let buf = '';
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (buf.length + sentence.length + 1 > target && buf) {
      chunks.push(buf);
      buf = sentence;
    } else {
      buf = buf ? `${buf} ${sentence}` : sentence;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}
