/**
 * Regression test for the chunk-straddling SSE bug.
 *
 * The runtime adapter parses SSE events from `fetch`'s `ReadableStream`.
 * The bug was that `eventType` was declared INSIDE the chunk-reading loop,
 * so an event whose `event:` and `data:` lines arrived in two different
 * network chunks had its `eventType` reset before the data line was
 * processed — the parser then dropped the event silently.
 *
 * In production this surfaced as a stuck "Running…" tool-call card when
 * the result payload was big enough to be split across TCP frames (we saw
 * it on a 100KB+ content-read result while two smaller siblings rendered
 * fine).
 *
 * These tests feed parseSSE a stream that's deliberately chopped at the
 * pathological split points and assert that the event still comes
 * through with the right shape.
 */

// Jest's default jsdom env predates the global Web Streams API; wp-scripts'
// jest config doesn't ship those globals either. Pull them off Node's
// built-ins so the tests run in the same env as the production runtime.
import {
  ReadableStream as NodeReadableStream,
  type ReadableStreamDefaultController,
} from "node:stream/web";
import {
  TextEncoder as NodeTextEncoder,
  TextDecoder as NodeTextDecoder,
} from "node:util";

import { parseSSE } from "../parse-sse";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ReadableStream ??= NodeReadableStream;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).TextEncoder ??= NodeTextEncoder;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).TextDecoder ??= NodeTextDecoder;

/**
 * Build a `ReadableStream<Uint8Array>` that yields the given string
 * chunks in order. Mirrors what `fetch().body` looks like to the parser.
 * @param chunks
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller: ReadableStreamDefaultController<Uint8Array>) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

describe("parseSSE", () => {
  test("single complete event in one chunk", async () => {
    const events = await collect(
      parseSSE(
        streamFromChunks(['event: text_delta\ndata: {"text":"hi"}\n\n']),
      ),
    );
    expect(events).toEqual([{ type: "text_delta", data: { text: "hi" } }]);
  });

  test("event header and data arrive in separate chunks", async () => {
    // Pathological split #1: `event:` line in chunk 1, `data:` in chunk 2.
    // Before the fix, eventType reset to null between chunks and the
    // data line was parsed with no event type → silently dropped.
    const events = await collect(
      parseSSE(
        streamFromChunks([
          "event: tool_result\n",
          'data: {"tool_use_id":"abc","result":{}}\n\n',
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "tool_result",
      data: { tool_use_id: "abc", result: {} },
    });
  });

  test("data line itself is split mid-JSON across chunks", async () => {
    // Pathological split #2: a multi-KB JSON payload doesn't fit in one
    // TCP frame. The `data:` line's content is split partway through.
    const huge = JSON.stringify({
      tool_use_id: "toolu_x",
      result: { content: "x".repeat(5000) },
    });
    const events = await collect(
      parseSSE(
        streamFromChunks([
          "event: tool_result\ndata: " + huge.slice(0, 100),
          huge.slice(100, 2500),
          huge.slice(2500) + "\n\n",
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("tool_result");
    expect((events[0]!.data as { tool_use_id: string }).tool_use_id).toBe(
      "toolu_x",
    );
  });

  test("three back-to-back tool_results survive arbitrary chunk boundaries", async () => {
    // Mirrors the production case: three same-shape tool calls fire in
    // parallel; the middle result is much larger than the other two and
    // the chunk boundary lands right between the second event's header
    // and its data line.
    const small = JSON.stringify({ tool_use_id: "id1", result: { ok: 1 } });
    const big = JSON.stringify({
      tool_use_id: "id2",
      result: { huge: "Y".repeat(8000) },
    });
    const third = JSON.stringify({ tool_use_id: "id3", result: { ok: 3 } });

    const stream = streamFromChunks([
      // Event 1: complete in chunk 1.
      `event: tool_result\ndata: ${small}\n\n`,
      // Event 2 header lands at end of chunk 1; data follows in chunks 2-4.
      "event: tool_result\n",
      "data: " + big.slice(0, 4000),
      big.slice(4000) + "\n\n",
      // Event 3: complete in its own chunk.
      `event: tool_result\ndata: ${third}\n\n`,
    ]);

    const events = await collect(parseSSE(stream));
    expect(events).toHaveLength(3);
    expect(
      events.map((e) => (e.data as { tool_use_id: string }).tool_use_id),
    ).toEqual(["id1", "id2", "id3"]);
  });

  test("blank line between events resets eventType so subsequent malformed events don't inherit it", async () => {
    // SSE-spec compliance: an empty line ends an event block.
    const events = await collect(
      parseSSE(
        streamFromChunks([
          'event: text_delta\ndata: {"text":"first"}\n\n',
          // No `event:` line for this stray `data:` — should be ignored.
          'data: {"text":"orphaned"}\n\n',
          'event: text_delta\ndata: {"text":"third"}\n\n',
        ]),
      ),
    );
    expect(events).toHaveLength(2);
    expect((events[0]!.data as { text: string }).text).toBe("first");
    expect((events[1]!.data as { text: string }).text).toBe("third");
  });

  test("malformed JSON in a data line is skipped, not thrown", async () => {
    const events = await collect(
      parseSSE(
        streamFromChunks([
          "event: text_delta\ndata: {not json}\n\n",
          'event: text_delta\ndata: {"text":"after"}\n\n',
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.data as { text: string }).text).toBe("after");
  });
});
