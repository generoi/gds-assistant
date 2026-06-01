/**
 * Tiny SSE (Server-Sent Events) parser for the chat stream.
 *
 * Lives in its own module so it can be unit-tested without dragging the
 * runtime adapter's `@wordpress/element` imports into the test sandbox.
 *
 * The server emits one event per blank-line-separated block — a single
 * `event:` line followed by a single `data:` line. We don't accumulate
 * multi-line `data:` chunks (the spec allows it but we never produce it).
 *
 * Subtle: `eventType` is declared OUTSIDE the chunk-reading loop because a
 * single SSE event can straddle multiple TCP chunks — the `event:` line in
 * chunk N, the `data:` line in chunk N+1. Resetting `eventType` per chunk
 * silently drops the data half of any event whose payload exceeds one TCP
 * frame (~64KB). This used to surface as a stuck "Running…" tool-call card
 * when a tool returned a result bigger than that.
 */

import type { RuntimeEvent } from "../types/runtime";

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RuntimeEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (eventType && data) {
            try {
              yield {
                type: eventType,
                data: JSON.parse(data),
              } as RuntimeEvent;
            } catch {
              // Skip malformed JSON
            }
          }
          eventType = null;
        } else if (line.trim() === "") {
          eventType = null;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
