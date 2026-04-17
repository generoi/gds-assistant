<?php

namespace GeneroWP\Assistant\Mcp;

interface AuthStrategyInterface
{
    /**
     * Return headers to merge into every MCP request. Empty array if the
     * server is reachable but no auth is yet available (caller should skip
     * or surface a connect prompt).
     */
    public function headers(): array;

    /**
     * Whether the strategy currently has credentials sufficient to call the
     * server. For bearer auth: token present. For OAuth: a non-expired access
     * token (refreshing if needed).
     */
    public function isAuthenticated(): bool;

    /**
     * Hook for 401/invalid_token responses — e.g. refresh an expired OAuth
     * token. Return true if a retry should be attempted.
     */
    public function handleUnauthorized(): bool;
}
