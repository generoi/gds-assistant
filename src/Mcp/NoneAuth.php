<?php

namespace GeneroWP\Assistant\Mcp;

class NoneAuth implements AuthStrategyInterface
{
    public function headers(): array
    {
        return [];
    }

    public function isAuthenticated(): bool
    {
        return true;
    }

    public function handleUnauthorized(): bool
    {
        return false;
    }
}
