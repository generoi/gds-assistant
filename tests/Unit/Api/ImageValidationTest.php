<?php

namespace GeneroWP\Assistant\Tests\Unit\Api;

use GeneroWP\Assistant\Api\ChatEndpoint;
use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class ImageValidationTest extends TestCase
{
    private ChatEndpoint $endpoint;

    private ReflectionMethod $normalizeMessages;

    protected function setUp(): void
    {
        parent::setUp();
        $this->endpoint = new ChatEndpoint(Plugin::getInstance());
        $this->normalizeMessages = new ReflectionMethod(ChatEndpoint::class, 'normalizeMessages');
        $this->normalizeMessages->setAccessible(true);
    }

    public function test_valid_image_passes(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image', 'source' => [
                        'type' => 'base64',
                        'media_type' => 'image/png',
                        'data' => str_repeat('A', 1000),
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $blocks = $result[0]['content'];

        $imageBlocks = array_filter($blocks, fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(1, $imageBlocks);
    }

    public function test_oversized_image_rejected(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'text', 'text' => 'What is this?'],
                    ['type' => 'image', 'source' => [
                        'type' => 'base64',
                        'media_type' => 'image/png',
                        'data' => str_repeat('A', 6 * 1024 * 1024), // 6MB
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $blocks = $result[0]['content'];

        $imageBlocks = array_filter($blocks, fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(0, $imageBlocks, 'Oversized image should be rejected');

        // Text block should still be present
        $textBlocks = array_filter($blocks, fn ($b) => ($b['type'] ?? '') === 'text');
        $this->assertCount(1, $textBlocks);
    }

    public function test_invalid_media_type_rejected(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => [
                        'type' => 'base64',
                        'media_type' => 'application/pdf',
                        'data' => str_repeat('A', 100),
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $blocks = $result[0]['content'];

        $imageBlocks = array_filter($blocks, fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(0, $imageBlocks, 'Non-image media type should be rejected');
    }

    public function test_allowed_image_types(): void
    {
        foreach (['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as $type) {
            $messages = [
                [
                    'role' => 'user',
                    'content' => [
                        ['type' => 'image', 'source' => [
                            'type' => 'base64',
                            'media_type' => $type,
                            'data' => 'dGVzdA==',
                        ]],
                    ],
                ],
            ];

            $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
            $imageBlocks = array_filter($result[0]['content'], fn ($b) => ($b['type'] ?? '') === 'image');
            $this->assertCount(1, $imageBlocks, "{$type} should be allowed");
        }
    }

    public function test_string_content_unchanged(): void
    {
        $messages = [
            ['role' => 'user', 'content' => 'Just text'],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $this->assertSame('Just text', $result[0]['content']);
    }

    public function test_url_image_same_origin_passes(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => [
                        'type' => 'url',
                        'url' => home_url('/wp-content/uploads/2026/04/photo.jpg'),
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $imageBlocks = array_filter($result[0]['content'], fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(1, $imageBlocks, 'Same-origin URL should pass');
    }

    public function test_url_image_https_external_passes(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => [
                        'type' => 'url',
                        'url' => 'https://example.com/photo.jpg',
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $imageBlocks = array_filter($result[0]['content'], fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(1, $imageBlocks, 'HTTPS external URL should pass');
    }

    public function test_url_image_http_external_rejected(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => [
                        'type' => 'url',
                        'url' => 'http://evil.com/image.jpg',
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $imageBlocks = array_filter($result[0]['content'], fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(0, $imageBlocks, 'HTTP external URL should be rejected');
    }

    public function test_url_image_invalid_url_rejected(): void
    {
        $messages = [
            [
                'role' => 'user',
                'content' => [
                    ['type' => 'image', 'source' => [
                        'type' => 'url',
                        'url' => 'not-a-url',
                    ]],
                ],
            ],
        ];

        $result = $this->normalizeMessages->invoke($this->endpoint, $messages);
        $imageBlocks = array_filter($result[0]['content'], fn ($b) => ($b['type'] ?? '') === 'image');
        $this->assertCount(0, $imageBlocks, 'Invalid URL should be rejected');
    }
}
