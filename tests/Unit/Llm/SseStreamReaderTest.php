<?php

namespace GeneroWP\Assistant\Tests\Unit\Llm;

use GeneroWP\Assistant\Llm\SseStreamReader;
use GeneroWP\Assistant\Tests\TestCase;

/**
 * Direct tests for the SSE parser. The chunk processor is exercised with
 * synthesised byte streams that cover the SSE quirks every provider hits
 * (multi-line events, comment/event-header drops, mid-line chunk splits,
 * malformed JSON, custom `[DONE]` sentinels).
 */
class SseStreamReaderTest extends TestCase
{
    /** @var array<int, array<string, mixed>> */
    private array $events = [];

    protected function setUp(): void
    {
        parent::setUp();
        $this->events = [];
    }

    private function collect(): callable
    {
        return function (array $event) {
            $this->events[] = $event;
        };
    }

    // ── processChunk: basic ─────────────────────────────────────

    public function test_processes_single_complete_event(): void
    {
        $buffer = '';
        SseStreamReader::processChunk(
            "data: {\"type\":\"text\",\"value\":\"hi\"}\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events);
        $this->assertSame(['type' => 'text', 'value' => 'hi'], $this->events[0]);
        $this->assertSame('', $buffer, 'A complete line should drain the buffer');
    }

    public function test_processes_multiple_events_in_one_chunk(): void
    {
        $buffer = '';
        SseStreamReader::processChunk(
            "data: {\"i\":1}\ndata: {\"i\":2}\ndata: {\"i\":3}\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(3, $this->events);
        $this->assertSame([1, 2, 3], array_column($this->events, 'i'));
    }

    public function test_stitches_event_split_across_chunks(): void
    {
        // The most common real-world quirk: TCP doesn't honour line boundaries,
        // so a single `data: {…}\n` event arrives as two or more chunks. The
        // parser must hold the partial line until the newline lands.
        $buffer = '';
        SseStreamReader::processChunk('data: {"type":"text"', $buffer, $this->collect());
        $this->assertSame([], $this->events, 'No event until the newline lands');

        SseStreamReader::processChunk(',"value":"hi"}', $buffer, $this->collect());
        $this->assertSame([], $this->events, 'Still no newline — still no event');

        SseStreamReader::processChunk("\n", $buffer, $this->collect());
        $this->assertCount(1, $this->events);
        $this->assertSame('hi', $this->events[0]['value']);
    }

    public function test_keeps_trailing_partial_in_buffer(): void
    {
        // Last line lacks `\n`; it should stay in the buffer for the next chunk.
        $buffer = '';
        SseStreamReader::processChunk(
            "data: {\"i\":1}\ndata: {\"i\":2",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events, 'Only the complete line should fire');
        $this->assertStringStartsWith('data: {"i":2', $buffer);
    }

    // ── processChunk: SSE-spec drops ──────────────────────────────

    public function test_drops_empty_lines_comments_and_event_headers(): void
    {
        // SSE spec says:
        //  - blank lines are dispatch terminators (no event data → no event)
        //  - lines starting with `:` are comments
        //  - `event: foo` sets the event type; we don't use named events.
        $buffer = '';
        SseStreamReader::processChunk(
            "event: message_start\n"
            ."\n"
            .": keepalive\n"
            ."data: {\"kept\":true}\n"
            ."\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events);
        $this->assertSame(['kept' => true], $this->events[0]);
    }

    public function test_ignores_non_data_lines(): void
    {
        // Lines that don't start with `data: ` are not events.
        $buffer = '';
        SseStreamReader::processChunk(
            "id: abc123\nretry: 1000\ndata: {\"kept\":true}\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events);
    }

    public function test_drops_malformed_json_silently(): void
    {
        // The provider mid-stream once emitted a truncated JSON; we must not
        // crash. The bad line is dropped and parsing of the next line continues.
        $buffer = '';
        SseStreamReader::processChunk(
            "data: {not json\ndata: {\"ok\":true}\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events);
        $this->assertSame(['ok' => true], $this->events[0]);
    }

    public function test_drops_json_that_decodes_to_non_array(): void
    {
        // `data: null`, `data: 42`, `data: "string"` all valid JSON but the
        // parser only dispatches arrays (objects). Anything else is a misuse.
        $buffer = '';
        SseStreamReader::processChunk(
            "data: null\ndata: 42\ndata: \"str\"\ndata: {\"ok\":true}\n",
            $buffer,
            $this->collect(),
        );

        $this->assertCount(1, $this->events);
        $this->assertSame(['ok' => true], $this->events[0]);
    }

    // ── lineSkipper ─────────────────────────────────────────────

    public function test_line_skipper_drops_matched_lines(): void
    {
        // OpenAI's hand-rolled SSE includes `data: [DONE]` as the terminator,
        // which is valid SSE but not valid JSON — the line skipper drops it
        // before the parser tries to decode.
        $buffer = '';
        $skipped = [];
        SseStreamReader::processChunk(
            "data: {\"chunk\":1}\ndata: [DONE]\ndata: {\"chunk\":2}\n",
            $buffer,
            $this->collect(),
            function (string $line) use (&$skipped) {
                if ($line === 'data: [DONE]') {
                    $skipped[] = $line;

                    return true;
                }

                return false;
            },
        );

        $this->assertCount(2, $this->events);
        $this->assertSame([1, 2], array_column($this->events, 'chunk'));
        $this->assertCount(1, $skipped);
    }

    public function test_line_skipper_runs_after_sse_defaults(): void
    {
        // Empty/comment/event-header drops happen first; the skipper should
        // not see them.
        $buffer = '';
        $sawByLineSkipper = [];
        SseStreamReader::processChunk(
            ": comment\n\nevent: foo\ndata: {\"ok\":true}\n",
            $buffer,
            $this->collect(),
            function (string $line) use (&$sawByLineSkipper) {
                $sawByLineSkipper[] = $line;

                return false;
            },
        );

        $this->assertSame(['data: {"ok":true}'], $sawByLineSkipper);
    }

    // ── buffer state across calls ───────────────────────────────

    public function test_buffer_survives_zero_byte_chunks(): void
    {
        // Some upstream proxies fire empty WRITEFUNCTION calls (curl's
        // documented behaviour around keep-alives). The parser must just
        // no-op rather than misinterpreting them.
        $buffer = 'data: {"partial":';
        SseStreamReader::processChunk('', $buffer, $this->collect());

        $this->assertSame([], $this->events);
        $this->assertSame('data: {"partial":', $buffer);
    }

    // ── describeHttpError ───────────────────────────────────────

    public function test_describes_error_with_nested_message(): void
    {
        // Anthropic/OpenAI common shape.
        $msg = SseStreamReader::describeHttpError(
            429,
            '{"error":{"message":"Rate limit","type":"rate_limit_error"}}',
        );

        $this->assertSame('API returned HTTP 429: Rate limit', $msg);
    }

    public function test_describes_error_with_string_error(): void
    {
        // Gemini sometimes returns `{"error":"…"}` (string, not object).
        $msg = SseStreamReader::describeHttpError(
            400,
            '{"error":"Invalid model"}',
        );

        $this->assertSame('API returned HTTP 400: Invalid model', $msg);
    }

    public function test_describes_error_falls_back_to_body_excerpt(): void
    {
        // When the body isn't JSON, surface a short excerpt so callers can
        // see what the provider sent.
        $msg = SseStreamReader::describeHttpError(500, 'Internal Server Error');

        $this->assertSame('API returned HTTP 500: Internal Server Error', $msg);
    }

    public function test_describes_error_truncates_long_bodies(): void
    {
        $body = str_repeat('x', 1000);
        $msg = SseStreamReader::describeHttpError(500, $body);

        // 'API returned HTTP 500: ' (23 chars) + 300 body chars
        $this->assertSame(23 + 300, strlen($msg));
    }

    public function test_describes_error_with_empty_body(): void
    {
        $msg = SseStreamReader::describeHttpError(503, '');

        $this->assertSame('API returned HTTP 503', $msg);
    }

    // ── Fixture replay: full Anthropic text-only stream ─────────

    public function test_replays_fixture_anthropic_text_only(): void
    {
        // The fixtures dir holds captured SSE bodies from each provider.
        // Replaying one end-to-end against processChunk catches regressions
        // where a real provider's wire format drifts away from what we expect.
        $body = file_get_contents(__DIR__.'/../../fixtures/anthropic-text-only.txt');
        $this->assertNotFalse($body);

        $buffer = '';
        SseStreamReader::processChunk($body, $buffer, $this->collect());

        // Whatever the exact event count, the stream should at least contain
        // a `message_start` and a final `message_stop` — the bookends every
        // Anthropic completion is required to emit.
        $types = array_column($this->events, 'type');
        $this->assertContains('message_start', $types);
        $this->assertContains('message_stop', $types);
    }

    public function test_replays_fixture_byte_by_byte_matches_whole(): void
    {
        // Feeding the same fixture one byte at a time should produce the
        // identical event sequence as feeding it in one shot. This pins the
        // mid-line stitching behaviour against accidental regressions.
        $body = (string) file_get_contents(__DIR__.'/../../fixtures/anthropic-text-only.txt');

        $whole = [];
        $buf = '';
        SseStreamReader::processChunk($body, $buf, function (array $e) use (&$whole) {
            $whole[] = $e;
        });

        $bytes = [];
        $buf = '';
        for ($i = 0, $n = strlen($body); $i < $n; $i++) {
            SseStreamReader::processChunk($body[$i], $buf, function (array $e) use (&$bytes) {
                $bytes[] = $e;
            });
        }

        $this->assertSame($whole, $bytes);
    }
}
