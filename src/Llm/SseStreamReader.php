<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Shared curl + line-buffered SSE parser used by every streaming provider
 * (Anthropic, OpenAI-compatible, Gemini). Owns the bits every provider was
 * copying verbatim:
 *
 *  - curl setup with POST + headers + body
 *  - capturing the error body on HTTP >= 400 (so it isn't fed to the line
 *    parser which would fail)
 *  - the `\n`-split state machine over chunked SSE input
 *  - parsing the standard `data: {…}` envelope
 *  - returning HTTP status + curl error for the caller's post-flight handling
 *
 * Provider-specific bits (which lines to skip, what shape each event has)
 * stay in the provider via a small {@see SseStreamReader::onEvent} callable
 * and the `lineSkipper` filter.
 */
final class SseStreamReader
{
    /**
     * Stream the given POST request and dispatch parsed `data:` events.
     *
     * @param  string  $url  The endpoint to POST to.
     * @param  array<int, string>  $headers  cURL HTTP headers (full `Key: value` strings).
     * @param  string  $body  Pre-encoded request body (typically `json_encode($payload)`).
     * @param  callable(array<string, mixed>): void  $onEvent  Called once per `data: {…}` JSON event with the decoded array.
     * @param  callable(string $rawLine): bool|null  $lineSkipper  Optional pre-filter: return true to drop the line (e.g. OpenAI's `data: [DONE]`). Called *after* the empty-line / non-`data:` defaults.
     * @return array{httpCode: int, errorBody: string, curlError: string}
     */
    public static function stream(
        string $url,
        array $headers,
        string $body,
        callable $onEvent,
        ?callable $lineSkipper = null,
    ): array {
        $errorBody = '';
        $lineBuffer = '';

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (
                &$lineBuffer,
                &$errorBody,
                $onEvent,
                $lineSkipper,
            ) {
                // Non-200 responses are never SSE — buffer the whole body so
                // the caller can decode the error envelope (most providers
                // return JSON `{error:{message:...}}`).
                $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                if ($httpCode >= 400) {
                    $errorBody .= $chunk;

                    return strlen($chunk);
                }

                $lineBuffer .= $chunk;
                while (($pos = strpos($lineBuffer, "\n")) !== false) {
                    $line = trim(substr($lineBuffer, 0, $pos));
                    $lineBuffer = substr($lineBuffer, $pos + 1);

                    // Standard SSE defaults: skip empty lines, comments (`:`),
                    // and `event:` headers. Providers can drop additional
                    // lines (e.g. OpenAI's `data: [DONE]`) via lineSkipper.
                    if ($line === '' || str_starts_with($line, ':') || str_starts_with($line, 'event: ')) {
                        continue;
                    }
                    if ($lineSkipper !== null && $lineSkipper($line)) {
                        continue;
                    }
                    if (! str_starts_with($line, 'data: ')) {
                        continue;
                    }

                    $event = json_decode(substr($line, 6), true);
                    if (! is_array($event)) {
                        continue;
                    }
                    $onEvent($event);
                }

                return strlen($chunk);
            },
        ]);

        curl_exec($ch);
        $httpCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $curlError = (string) curl_error($ch);
        curl_close($ch);

        return [
            'httpCode' => $httpCode,
            'errorBody' => $errorBody,
            'curlError' => $curlError,
        ];
    }

    /**
     * Format a provider error message from the HTTP status + raw body. Most
     * providers return `{error: {message: ...}}`; we surface that when
     * present, fall back to a short body excerpt otherwise.
     */
    public static function describeHttpError(int $httpCode, string $body): string
    {
        $msg = "API returned HTTP {$httpCode}";
        $decoded = json_decode($body, true);
        if (is_array($decoded)) {
            // Common shapes:  {error:{message}}  or  {error:{message,type}}
            if (isset($decoded['error']['message']) && is_string($decoded['error']['message'])) {
                return $msg.': '.$decoded['error']['message'];
            }
            // Gemini: error is at top-level under a different key sometimes
            if (isset($decoded['error']) && is_string($decoded['error'])) {
                return $msg.': '.$decoded['error'];
            }
        }
        if ($body !== '') {
            return $msg.': '.substr($body, 0, 300);
        }

        return $msg;
    }
}
