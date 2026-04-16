<?php
/**
 * List available models for every configured LLM provider.
 *
 * Usage:
 *   php bin/list-models.php                     # all providers
 *   php bin/list-models.php anthropic openai    # only these
 *
 * Reads API keys from the environment (same names as ProviderRegistry).
 * Outputs model IDs plus a pointer to each provider's pricing page so you
 * can cross-check before editing src/Llm/ProviderRegistry.php.
 *
 * Pricing is deliberately NOT fetched — no provider exposes it via API.
 * The pricing URLs below are the canonical sources; verify there.
 */

declare(strict_types=1);

$providers = [
    'anthropic' => [
        'env' => ['GDS_ASSISTANT_ANTHROPIC_KEY', 'GDS_ASSISTANT_API_KEY', 'ANTHROPIC_API_KEY'],
        'endpoint' => 'https://api.anthropic.com/v1/models',
        'headers' => fn ($k) => ['x-api-key: '.$k, 'anthropic-version: 2023-06-01'],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://platform.claude.com/docs/en/about-claude/pricing',
    ],
    'openai' => [
        'env' => ['GDS_ASSISTANT_OPENAI_KEY', 'OPENAI_API_KEY'],
        'endpoint' => 'https://api.openai.com/v1/models',
        'headers' => fn ($k) => ['Authorization: Bearer '.$k],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://openai.com/api/pricing/',
    ],
    'gemini' => [
        'env' => ['GDS_ASSISTANT_GEMINI_KEY', 'GOOGLE_AI_API_KEY'],
        'endpoint' => fn ($k) => 'https://generativelanguage.googleapis.com/v1beta/models?key='.$k,
        'headers' => fn ($k) => [],
        'extract' => fn ($d) => array_map(
            fn ($m) => str_replace('models/', '', $m['name'] ?? ''),
            array_filter($d['models'] ?? [], fn ($m) => in_array('generateContent', $m['supportedGenerationMethods'] ?? [], true)),
        ),
        'pricing_url' => 'https://ai.google.dev/gemini-api/docs/pricing',
    ],
    'vertex' => [
        'env' => ['GDS_ASSISTANT_VERTEX_KEY', 'VERTEX_API_KEY'],
        // Vertex Express doesn't expose a models.list endpoint via API key.
        // We probe known-current model IDs and report which respond 2xx.
        'endpoint' => null,
        'probe' => [
            'gemini-3.1-pro-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-3-pro-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite',
            'gemini-2.0-flash',
            'gemini-flash-latest',
            'gemini-pro-latest',
        ],
        'pricing_url' => 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    ],
    'mistral' => [
        'env' => ['GDS_ASSISTANT_MISTRAL_KEY', 'MISTRAL_API_KEY'],
        'endpoint' => 'https://api.mistral.ai/v1/models',
        'headers' => fn ($k) => ['Authorization: Bearer '.$k],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://mistral.ai/pricing',
    ],
    'groq' => [
        'env' => ['GDS_ASSISTANT_GROQ_KEY', 'GROQ_API_KEY'],
        'endpoint' => 'https://api.groq.com/openai/v1/models',
        'headers' => fn ($k) => ['Authorization: Bearer '.$k],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://groq.com/pricing/',
    ],
    'xai' => [
        'env' => ['GDS_ASSISTANT_XAI_KEY', 'XAI_API_KEY'],
        'endpoint' => 'https://api.x.ai/v1/models',
        'headers' => fn ($k) => ['Authorization: Bearer '.$k],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://docs.x.ai/developers/models',
    ],
    'deepseek' => [
        'env' => ['GDS_ASSISTANT_DEEPSEEK_KEY', 'DEEPSEEK_API_KEY'],
        'endpoint' => 'https://api.deepseek.com/v1/models',
        'headers' => fn ($k) => ['Authorization: Bearer '.$k],
        'extract' => fn ($d) => array_column($d['data'] ?? [], 'id'),
        'pricing_url' => 'https://api-docs.deepseek.com/quick_start/pricing/',
    ],
];

// Optionally source a .env file from a conventional project root.
// Looks for ../../../../../.env (plugin → wp-plugins → app → web → project root).
$envFile = __DIR__.'/../../../../../.env';
if (is_readable($envFile)) {
    foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
        if (str_starts_with(trim($line), '#') || ! str_contains($line, '=')) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        $v = trim($v, " \t\n\r\0\x0B'\"");
        if (! getenv(trim($k))) {
            putenv(trim($k).'='.$v);
        }
    }
}

function getKey(array $envNames): ?string
{
    foreach ($envNames as $name) {
        $v = getenv($name);
        if ($v !== false && $v !== '') {
            // Strip any trailing space+comment (e.g. a service account email appended to a Vertex key).
            return explode(' ', trim($v))[0];
        }
    }

    return null;
}

function httpJson(string $url, array $headers, string $method = 'GET'): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_TIMEOUT => 15,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code >= 400) {
        return ['__error' => "HTTP $code", '__body' => substr((string) $body, 0, 200)];
    }

    return json_decode((string) $body, true) ?: ['__error' => 'invalid JSON'];
}

function probeVertexModel(string $key, string $model): int
{
    $ch = curl_init("https://aiplatform.googleapis.com/v1beta1/publishers/google/models/$model:generateContent?key=$key");
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => '{"contents":[{"role":"user","parts":[{"text":"hi"}]}],"generationConfig":{"maxOutputTokens":10}}',
        CURLOPT_TIMEOUT => 15,
    ]);
    curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return $code;
}

$selected = array_slice($argv, 1);
$toRun = $selected ?: array_keys($providers);

foreach ($toRun as $name) {
    if (! isset($providers[$name])) {
        fwrite(STDERR, "Unknown provider: $name\n");

        continue;
    }
    $p = $providers[$name];
    $key = getKey($p['env']);

    echo "\n\033[1m=== $name ===\033[0m\n";
    echo "Pricing: {$p['pricing_url']}\n";

    if (! $key) {
        echo "  (no API key configured: ".implode(' / ', $p['env']).")\n";

        continue;
    }

    if (isset($p['probe'])) {
        // Vertex — probe known IDs
        echo "  Probing known model IDs via generateContent:\n";
        foreach ($p['probe'] as $m) {
            $code = probeVertexModel($key, $m);
            $marker = $code < 400 ? "\033[32m✓\033[0m" : "\033[31m✗\033[0m";
            echo "    $marker  $m  (HTTP $code)\n";
        }

        continue;
    }

    $url = is_callable($p['endpoint']) ? ($p['endpoint'])($key) : $p['endpoint'];
    $headers = ($p['headers'])($key);
    $data = httpJson($url, $headers);

    if (isset($data['__error'])) {
        echo "  ERROR: {$data['__error']}  {$data['__body']}\n";

        continue;
    }

    $ids = ($p['extract'])($data);
    sort($ids);
    foreach ($ids as $id) {
        echo "  $id\n";
    }
    echo "  (".count($ids)." models)\n";
}

echo "\nTip: run with a subset, e.g. `php bin/list-models.php anthropic openai`.\n";
echo "Pricing is NOT fetched — open the URLs above to verify before editing ProviderRegistry.\n";
