<?php

namespace GeneroWP\Assistant\Bridge;

use GeneroWP\Assistant\Llm\ProviderRegistry;

/**
 * Generate an image via OpenAI gpt-image-1 and import it into the WP media
 * library, returning an attachment id the model can then insert or assign to
 * an existing image block via the editor tools. Free chat flow: the model
 * calls `assistant__generate_image` → gets `{attachment_id, url, alt}` →
 * uses `editor__insert_blocks` (or `editor__update_block_attributes` on an
 * existing core/image) to land it in the editor.
 *
 * Cost-conscious: gpt-image-1 generations are far pricier than chat tokens,
 * so they count against a separate per-user daily budget (filterable via
 * `gds-assistant/image_daily_limit`) instead of being absorbed into the
 * existing token budget.
 */
class ImageGenerationToolProvider implements ToolProviderInterface
{
    /** Default daily image budget per user. Override with filter `gds-assistant/image_daily_limit`. */
    private const DEFAULT_DAILY_LIMIT = 20;

    /** Hard timeout on a single image generation — gpt-image-1 typically responds in 10–30s. */
    private const REQUEST_TIMEOUT_SECONDS = 90;

    public function getTools(): array
    {
        return [
            [
                'name' => 'assistant__generate_image',
                'description' => 'Generate an image with OpenAI gpt-image-1 and import it into the WordPress media library. Returns the attachment_id + url + alt — use them with editor__insert_blocks (for a new core/image block) or editor__update_block_attributes (to swap an existing image block\'s id/url/alt). Describe the subject in `prompt` — gpt-image-1 follows specific direction well. Pass `reference_image_url` OR `reference_attachment_id` to base the new image on an existing one (uses gpt-image-1\'s edit endpoint) — e.g. when the user asks to "replace this image but keep the same style".',
                'input_schema' => [
                    'type' => 'object',
                    'properties' => [
                        'prompt' => [
                            'type' => 'string',
                            'description' => 'What the image should show. Be specific (subject, style, lighting, mood). When a reference image is supplied, describe what should CHANGE relative to it.',
                        ],
                        'aspect_ratio' => [
                            'type' => 'string',
                            'enum' => ['square', 'landscape', 'portrait'],
                            'description' => 'square (1024x1024), landscape (1536x1024), or portrait (1024x1536). Default: square. Ignored when editing a reference image (output matches the reference\'s aspect).',
                        ],
                        'quality' => [
                            'type' => 'string',
                            'enum' => ['low', 'medium', 'high'],
                            'description' => 'Higher quality costs more. Default medium.',
                        ],
                        'alt' => [
                            'type' => 'string',
                            'description' => 'Alt text to set on the resulting attachment. Defaults to the prompt — override if the image is decorative or the prompt isn\'t a good alt.',
                        ],
                        'reference_image_url' => [
                            'type' => 'string',
                            'description' => 'Optional URL of an existing image to use as the basis. Must be a PNG / JPG / WEBP and reachable from the server. Triggers the gpt-image-1 edit flow so the output preserves the reference\'s subject/composition.',
                        ],
                        'reference_attachment_id' => [
                            'type' => 'integer',
                            'description' => 'Alternative to reference_image_url: a WP attachment id. Convenient when the user pointed at a media-library image (e.g. the current core/image block\'s id).',
                        ],
                    ],
                    'required' => ['prompt'],
                ],
            ],
        ];
    }

    public function executeTool(string $name, array $input): mixed
    {
        $capability = apply_filters('gds-assistant/capability', 'edit_posts');
        if (! current_user_can($capability)) {
            return new \WP_Error('forbidden', 'Insufficient permissions');
        }
        if ($name !== 'assistant__generate_image') {
            return new \WP_Error('unknown_tool', "Unknown tool: {$name}");
        }

        return $this->generateImage($input);
    }

    public function handles(string $name): bool
    {
        return $name === 'assistant__generate_image';
    }

    private function generateImage(array $input): array|\WP_Error
    {
        $prompt = trim((string) ($input['prompt'] ?? ''));
        if ($prompt === '') {
            return new \WP_Error('bad_input', 'prompt is required');
        }

        $userId = get_current_user_id();
        $limit = (int) apply_filters('gds-assistant/image_daily_limit', self::DEFAULT_DAILY_LIMIT, $userId);
        $usedToday = $this->dailyCount($userId);
        if ($limit > 0 && $usedToday >= $limit) {
            return new \WP_Error(
                'image_budget_exceeded',
                "Daily image generation budget reached ({$usedToday}/{$limit}). Try again tomorrow."
            );
        }

        $apiKey = ProviderRegistry::getApiKey('openai');
        if (! $apiKey) {
            return new \WP_Error(
                'no_api_key',
                'OpenAI API key not configured — set OPENAI_API_KEY in the environment.'
            );
        }

        $size = match ($input['aspect_ratio'] ?? 'square') {
            'landscape' => '1536x1024',
            'portrait' => '1024x1536',
            default => '1024x1024',
        };
        $quality = $input['quality'] ?? 'medium';
        if (! in_array($quality, ['low', 'medium', 'high'], true)) {
            $quality = 'medium';
        }

        // Resolve a reference image (URL or attachment id) — when one is
        // supplied we hit the `/images/edits` endpoint, which preserves the
        // input's composition while applying the prompt as the change. No
        // reference → straight generation.
        $referenceBinary = null;
        $referenceMime = null;
        $referenceSource = null;
        if (! empty($input['reference_attachment_id'])) {
            [$referenceBinary, $referenceMime, $referenceSource] = $this->loadAttachment(
                (int) $input['reference_attachment_id'],
            );
            if ($referenceBinary instanceof \WP_Error) {
                return $referenceBinary;
            }
        } elseif (! empty($input['reference_image_url'])) {
            [$referenceBinary, $referenceMime, $referenceSource] = $this->loadRemoteImage(
                (string) $input['reference_image_url'],
            );
            if ($referenceBinary instanceof \WP_Error) {
                return $referenceBinary;
            }
        }

        $response = $referenceBinary !== null
            ? $this->callEditEndpoint($apiKey, $prompt, $quality, $referenceBinary, $referenceMime)
            : $this->callGenerateEndpoint($apiKey, $prompt, $size, $quality);

        if (is_wp_error($response)) {
            return $response;
        }
        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            $body = wp_remote_retrieve_body($response);
            $decoded = json_decode($body, true);
            $msg = $decoded['error']['message'] ?? substr($body, 0, 300);

            return new \WP_Error('openai_error', "OpenAI returned HTTP {$code}: {$msg}");
        }

        $data = json_decode(wp_remote_retrieve_body($response), true);
        $b64 = $data['data'][0]['b64_json'] ?? null;
        if (! $b64) {
            return new \WP_Error('no_image_in_response', 'OpenAI response did not contain an image');
        }
        $binary = base64_decode($b64, true);
        if ($binary === false) {
            return new \WP_Error('decode_failed', 'Failed to decode the image data from OpenAI');
        }

        $alt = trim((string) ($input['alt'] ?? '')) ?: $prompt;
        $attachmentId = $this->sideloadBinary($binary, $prompt, $alt);
        if (is_wp_error($attachmentId)) {
            return $attachmentId;
        }

        $this->recordDailyUsage($userId);

        return [
            'attachment_id' => $attachmentId,
            'url' => wp_get_attachment_url($attachmentId),
            'alt' => $alt,
            'size' => $referenceBinary !== null ? 'matches reference' : $size,
            'quality' => $quality,
            'based_on_reference' => $referenceSource,
            'budget_remaining' => $limit > 0 ? max(0, $limit - $usedToday - 1) : null,
        ];
    }

    /**
     * POST to /v1/images/generations — text-only generation.
     *
     * @return array|\WP_Error raw wp_remote_post result
     */
    private function callGenerateEndpoint(string $apiKey, string $prompt, string $size, string $quality)
    {
        return wp_remote_post('https://api.openai.com/v1/images/generations', [
            'headers' => [
                'Authorization' => 'Bearer '.$apiKey,
                'Content-Type' => 'application/json',
            ],
            'body' => wp_json_encode([
                'model' => 'gpt-image-1',
                'prompt' => $prompt,
                'size' => $size,
                'quality' => $quality,
                'n' => 1,
                'output_format' => 'png',
            ]),
            'timeout' => self::REQUEST_TIMEOUT_SECONDS,
        ]);
    }

    /**
     * POST to /v1/images/edits — image-conditioned generation. The endpoint
     * uses multipart/form-data with an `image` file part; wp_remote_post
     * doesn't have first-class multipart support, so we build the body and
     * boundary by hand.
     *
     * @return array|\WP_Error raw wp_remote_post result
     */
    private function callEditEndpoint(
        string $apiKey,
        string $prompt,
        string $quality,
        string $imageBinary,
        ?string $mime,
    ) {
        $boundary = wp_generate_password(24, false);
        $eol = "\r\n";
        $ext = match ($mime) {
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'image/webp' => 'webp',
            default => 'png',
        };
        $contentType = $mime ?: 'image/png';

        $parts = '';
        // image file part
        $parts .= "--{$boundary}{$eol}";
        $parts .= "Content-Disposition: form-data; name=\"image\"; filename=\"reference.{$ext}\"{$eol}";
        $parts .= "Content-Type: {$contentType}{$eol}{$eol}";
        $parts .= $imageBinary.$eol;
        // simple text fields
        foreach (
            ['model' => 'gpt-image-1', 'prompt' => $prompt, 'quality' => $quality, 'n' => '1'] as $name => $value
        ) {
            $parts .= "--{$boundary}{$eol}";
            $parts .= "Content-Disposition: form-data; name=\"{$name}\"{$eol}{$eol}";
            $parts .= $value.$eol;
        }
        $parts .= "--{$boundary}--{$eol}";

        return wp_remote_post('https://api.openai.com/v1/images/edits', [
            'headers' => [
                'Authorization' => 'Bearer '.$apiKey,
                'Content-Type' => "multipart/form-data; boundary={$boundary}",
            ],
            'body' => $parts,
            'timeout' => self::REQUEST_TIMEOUT_SECONDS,
        ]);
    }

    /**
     * Resolve a WP attachment id to its raw bytes + mime + a human-readable
     * source label for the result payload.
     *
     * @return array{0: string|\WP_Error, 1: string|null, 2: string|null}
     */
    private function loadAttachment(int $attachmentId): array
    {
        if ($attachmentId <= 0) {
            return [new \WP_Error('bad_attachment', 'reference_attachment_id must be a positive integer'), null, null];
        }
        $path = get_attached_file($attachmentId);
        if (! $path || ! file_exists($path)) {
            return [new \WP_Error('attachment_missing', "Attachment {$attachmentId} has no file on disk"), null, null];
        }
        $mime = get_post_mime_type($attachmentId) ?: 'image/png';
        if (! str_starts_with($mime, 'image/')) {
            return [new \WP_Error('not_an_image', "Attachment {$attachmentId} is not an image ({$mime})"), null, null];
        }
        $size = filesize($path);
        if ($size > 20 * 1024 * 1024) {
            return [new \WP_Error('reference_too_large', 'Reference image is over 20 MB — gpt-image-1 won\'t accept it'), null, null];
        }
        $binary = file_get_contents($path);
        if ($binary === false) {
            return [new \WP_Error('attachment_read_failed', "Couldn't read attachment {$attachmentId}"), null, null];
        }

        return [$binary, $mime, "attachment {$attachmentId}"];
    }

    /**
     * Fetch an external image URL, with bounded size + mime guarding.
     *
     * @return array{0: string|\WP_Error, 1: string|null, 2: string|null}
     */
    private function loadRemoteImage(string $url): array
    {
        $url = trim($url);
        if ($url === '' || ! wp_http_validate_url($url)) {
            return [new \WP_Error('bad_url', 'reference_image_url is not a valid URL'), null, null];
        }
        $response = wp_remote_get($url, [
            'timeout' => 30,
            // Cap roughly at 20 MB by reading the full body but bailing if
            // it exceeds — gpt-image-1's per-file limit is 25 MB.
            'limit_response_size' => 20 * 1024 * 1024,
        ]);
        if (is_wp_error($response)) {
            return [$response, null, null];
        }
        $code = wp_remote_retrieve_response_code($response);
        if ($code !== 200) {
            return [new \WP_Error('fetch_failed', "Reference URL returned HTTP {$code}"), null, null];
        }
        $body = wp_remote_retrieve_body($response);
        if ($body === '') {
            return [new \WP_Error('empty_response', 'Reference URL returned an empty body'), null, null];
        }
        $mime = wp_remote_retrieve_header($response, 'content-type') ?: null;
        // Strip charset suffix if any.
        if ($mime && str_contains($mime, ';')) {
            $mime = trim(explode(';', $mime, 2)[0]);
        }
        if (! $mime || ! str_starts_with($mime, 'image/')) {
            return [new \WP_Error('not_an_image', "Reference URL is not an image (Content-Type: {$mime})"), null, null];
        }

        return [$body, $mime, 'url '.$url];
    }

    /**
     * Decode-then-sideload the PNG into the media library. Avoids
     * `media_handle_sideload` because that pulls in the admin form bootstrap;
     * `wp_handle_sideload` + `wp_insert_attachment` is enough at this level.
     */
    private function sideloadBinary(string $binary, string $prompt, string $alt): int|\WP_Error
    {
        require_once ABSPATH.'wp-admin/includes/file.php';
        require_once ABSPATH.'wp-admin/includes/image.php';
        require_once ABSPATH.'wp-admin/includes/media.php';

        $tmpFile = wp_tempnam('ai-image.png');
        if (! $tmpFile) {
            return new \WP_Error('tmp_failed', 'Failed to create a temp file for the generated image');
        }
        $written = file_put_contents($tmpFile, $binary);
        if ($written === false) {
            @unlink($tmpFile);

            return new \WP_Error('write_failed', 'Failed to write the generated image to disk');
        }

        $slug = sanitize_title(substr($prompt, 0, 60)) ?: 'ai-image';
        $filename = "{$slug}-".substr(wp_generate_uuid4(), 0, 8).'.png';

        $file = [
            'name' => $filename,
            'tmp_name' => $tmpFile,
            'error' => 0,
            'size' => filesize($tmpFile),
            'type' => 'image/png',
        ];
        $sideloaded = wp_handle_sideload($file, ['test_form' => false]);
        if (isset($sideloaded['error'])) {
            @unlink($tmpFile);

            return new \WP_Error('sideload_failed', $sideloaded['error']);
        }

        $attachment = [
            'guid' => $sideloaded['url'],
            'post_mime_type' => $sideloaded['type'],
            'post_title' => $slug,
            'post_content' => 'AI-generated via gpt-image-1. Prompt: '.$prompt,
            'post_excerpt' => $alt,
            'post_status' => 'inherit',
        ];
        $attachmentId = wp_insert_attachment($attachment, $sideloaded['file']);
        if (is_wp_error($attachmentId)) {
            return $attachmentId;
        }

        $metadata = wp_generate_attachment_metadata($attachmentId, $sideloaded['file']);
        wp_update_attachment_metadata($attachmentId, $metadata);

        update_post_meta($attachmentId, '_wp_attachment_image_alt', $alt);
        // Tag it so admins can find AI generations later if needed.
        update_post_meta($attachmentId, '_gds_assistant_ai_generated', 1);
        update_post_meta($attachmentId, '_gds_assistant_ai_prompt', $prompt);

        return $attachmentId;
    }

    private function dailyKey(): string
    {
        return 'gds_assistant_images_'.gmdate('Y-m-d');
    }

    private function dailyCount(int $userId): int
    {
        if ($userId <= 0) {
            return 0;
        }

        return (int) get_user_meta($userId, $this->dailyKey(), true);
    }

    private function recordDailyUsage(int $userId): void
    {
        if ($userId <= 0) {
            return;
        }
        $key = $this->dailyKey();
        $current = (int) get_user_meta($userId, $key, true);
        update_user_meta($userId, $key, $current + 1);
    }
}
