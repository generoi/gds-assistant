<?php

namespace GeneroWP\Assistant\Llm;

/**
 * Vertex AI Express Mode provider. Same API shape as Gemini AI Studio,
 * but hits the Vertex endpoint and gets data-residency / no-training guarantees.
 * Express Mode API keys start with "AQ." and pass via ?key= (no OAuth2 needed).
 */
class VertexExpressProvider extends GeminiProvider
{
    private const API_BASE = 'https://aiplatform.googleapis.com/v1/publishers/google/models';

    public function name(): string
    {
        return 'vertex';
    }

    protected function apiUrl(): string
    {
        return self::API_BASE."/{$this->model}:streamGenerateContent?alt=sse&key={$this->apiKey}";
    }
}
