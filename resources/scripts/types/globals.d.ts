/**
 * Shape of `window.gdsAssistant` — the cross-cutting object PHP localises
 * onto `window` and our scripts attach hooks to. Lives in its own ambient
 * `.d.ts` so every module sees the same merged declaration; without this
 * each file's local `declare global` would race-merge and produce {}
 * intersections for shared keys.
 *
 * REST routes are exposed under two prefixes:
 *   - `restUrl`  — our plugin namespace (e.g. `/wp-json/gds-assistant/v1/`)
 *   - `restBase` — the core WP base (`/wp-json/`) for cross-plugin calls
 */

import type { Skill } from "../components/skills-cache";

declare global {
  interface GdsAssistantGlobal {
    /** Our plugin's REST namespace, trailing slash included. */
    restUrl?: string;
    /** Core WP REST base, trailing slash included. */
    restBase?: string;
    /** REST nonce header value. */
    nonce?: string;
    /** `model_key → [input, output, cache_read?, cache_write?]` USD/MTok. */
    modelPricing?: Record<string, number[]>;
    /** Voice dictation languages enabled for this site (Polylang langs). */
    voiceLanguages?: Array<{ code: string; label: string }>;
    /** PHP-injected initial skill list — seeds the cache before first fetch. */
    skills?: Skill[];
    /** Open the chat panel programmatically (set by use-runtime-adapter). */
    openChat?: () => void;
    /** Send a message as if the user typed it (set by use-runtime-adapter). */
    sendChatMessage?: (text: string) => void;
  }

  interface Window {
    gdsAssistant?: GdsAssistantGlobal;
  }
}

// This file augments global scope; it is not a module otherwise.
export {};
