<?php

namespace GeneroWP\Assistant\Mcp;

use GeneroWP\Assistant\Plugin;

class BearerAuth implements AuthStrategyInterface
{
    public function __construct(
        private readonly array $config,
    ) {}

    public function headers(): array
    {
        $token = $this->resolveToken();
        if (! $token) {
            return [];
        }

        return ['Authorization' => 'Bearer '.$token];
    }

    public function isAuthenticated(): bool
    {
        return (bool) $this->resolveToken();
    }

    public function handleUnauthorized(): bool
    {
        return false;
    }

    private function resolveToken(): ?string
    {
        if (! empty($this->config['token'])) {
            return (string) $this->config['token'];
        }

        if (! empty($this->config['env'])) {
            $value = Plugin::env($this->config['env']);

            return $value ? (string) $value : null;
        }

        return null;
    }
}
