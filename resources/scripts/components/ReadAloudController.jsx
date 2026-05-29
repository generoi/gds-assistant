/**
 * Side-effect component (renders nothing). Subscribes to the chat thread
 * runtime and, when the read-aloud toggle is on, reads each completed
 * assistant message aloud via the Web Speech API.
 *
 * Streaming-aware: queues complete sentences as they land instead of waiting
 * for the whole reply. Speech is cancelled when a new run starts, when the
 * toggle is flipped off, or when the component unmounts (chat panel closes).
 */

import { useThreadRuntime } from "@assistant-ui/react";
import { useEffect } from "@wordpress/element";

import {
  cancelTts,
  extractAssistantText,
  readVoiceLang,
  speakAppend,
  ttsSupported,
  useTtsEnabled,
} from "../hooks/use-tts";

export function ReadAloudController() {
  const [enabled] = useTtsEnabled();
  const threadRuntime = useThreadRuntime();

  useEffect(() => {
    if (!enabled || !ttsSupported()) return undefined;

    let wasRunning = false;
    // Per-message bookkeeping for streaming reads. We track the offset into
    // the message's plain text that we've already queued for speech, so each
    // tick we only enqueue the *new* fully-formed sentences. Map keyed by a
    // stable per-message key so an interim id changing to a final id (which
    // assistant-ui sometimes does on completion) doesn't reset progress.
    const progress = new Map(); // key -> {offset, lastTextLen, finalised}

    const speakUpTo = (key, text, lang, atEnd) => {
      const state = progress.get(key) || {
        offset: 0,
        lastTextLen: 0,
        finalised: false,
      };
      const remainder = text.slice(state.offset);
      if (!remainder.length) {
        progress.set(key, { ...state, lastTextLen: text.length });
        return;
      }

      // Mid-stream: only queue *complete* sentences so we don't speak a half
      // word the engine then re-pronounces when the next token arrives. At
      // the end of the run, just speak everything that's left regardless.
      let consume = 0;
      if (atEnd) {
        consume = remainder.length;
      } else {
        // Last sentence-terminator in the remainder. JS regex doesn't expose
        // lastIndexOf for patterns, so iterate.
        const re = /[.!?。！？]["')\]]?(?=\s|$)/g;
        let m;
        let lastEnd = -1;
        while ((m = re.exec(remainder)) !== null) {
          lastEnd = m.index + m[0].length;
        }
        if (lastEnd < 0) return;
        // Don't speak less than a few words; avoids machine-gun queueing
        // when the model emits short fragments token-by-token.
        if (lastEnd < 16) return;
        consume = lastEnd;
      }

      const chunk = remainder.slice(0, consume).trim();
      if (chunk) speakAppend(chunk, lang);
      progress.set(key, {
        offset: state.offset + consume,
        lastTextLen: text.length,
        finalised: atEnd,
      });
    };

    // Has the user actually started a run in *this* mount? Until they do,
    // every assistant message we see is loaded history — never to be
    // narrated. This is the only reliable refresh-safety check: seeding
    // messages on mount doesn't help because the runtime loads them
    // asynchronously *after* the controller has subscribed.
    let armed = false;

    const tick = () => {
      const state = threadRuntime.getState?.();
      if (!state) return;
      const running = !!state.isRunning;
      const messages = state.messages || [];

      // A false → true transition is the user-initiated signal that turns on
      // narration. Until then we silently track state and never speak.
      if (running && !wasRunning) {
        armed = true;
        cancelTts();
      }

      if (!armed) {
        wasRunning = running;
        return;
      }

      // Only narrate when the most recent message in the thread is an
      // assistant message. After a user send the tail is the user's message,
      // so falling back to the *previous* assistant would speak the prior
      // reply. The tail index doubles as the key so an id change between
      // interim and final doesn't reset the spoken offset.
      const tail = messages[messages.length - 1];
      if (tail?.role !== "assistant") {
        wasRunning = running;
        return;
      }

      const tailIdx = messages.length - 1;
      const key = tail.id || `idx:${tailIdx}`;
      const text = extractAssistantText(tail);
      if (text) speakUpTo(key, text, readVoiceLang(), !running);

      wasRunning = running;
    };

    // Seed `wasRunning` from the current state so a refresh that lands
    // mid-stream doesn't fire a spurious "run just started" cancel on the
    // first tick. (The `armed` gate above takes care of the "don't narrate
    // history" guarantee.)
    wasRunning = !!threadRuntime.getState?.()?.isRunning;

    const unsub = threadRuntime.subscribe(tick);
    return () => {
      if (typeof unsub === "function") unsub();
      cancelTts();
    };
  }, [enabled, threadRuntime]);

  return null;
}
