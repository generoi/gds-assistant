<?php

namespace GeneroWP\Assistant\Llm;

use GeneroWP\Assistant\Plugin;

final class CredentialResolver
{
    /**
     * @param  string[]  $legacyEnvVars
     * @return array{key: string|null, source: string, connector: array<string, mixed>|null, setting: string|null}
     */
    public static function resolve(string $providerName, array $legacyEnvVars = [], ?string $connectorId = null): array
    {
        $connectorId ??= $providerName;
        $connector = self::getConnector($connectorId);

        $connectorSources = self::connectorSources($connectorId, $connector);
        foreach ($connectorSources as $source) {
            $key = self::readSource($source['type'], $source['name']);
            if ($key) {
                return [
                    'key' => $key,
                    'source' => "connector:{$source['type']}:{$source['name']}",
                    'connector' => $connector,
                    'setting' => $source['type'] === 'option' ? $source['name'] : null,
                ];
            }
        }

        foreach ($legacyEnvVars as $envVar) {
            $key = self::readSource('env', $envVar) ?: self::readSource('constant', $envVar);
            if ($key) {
                return [
                    'key' => $key,
                    'source' => "legacy:env:{$envVar}",
                    'connector' => $connector,
                    'setting' => null,
                ];
            }

            $value = Plugin::env($envVar);
            if ($value) {
                return [
                    'key' => (string) $value,
                    'source' => "legacy:env:{$envVar}",
                    'connector' => $connector,
                    'setting' => null,
                ];
            }
        }

        return [
            'key' => null,
            'source' => $connector ? 'missing:connector' : 'missing',
            'connector' => $connector,
            'setting' => null,
        ];
    }

    /** @return array<string, mixed>|null */
    private static function getConnector(string $connectorId): ?array
    {
        if (! function_exists('wp_get_connectors')) {
            return null;
        }

        $connectors = wp_get_connectors();
        if (! is_array($connectors) || ! isset($connectors[$connectorId])) {
            return null;
        }

        $connector = $connectors[$connectorId];
        if (is_object($connector)) {
            $connector = get_object_vars($connector);
        }

        return is_array($connector) ? $connector : null;
    }

    /**
     * @param  array<string, mixed>|null  $connector
     * @return array<int, array{type: string, name: string}>
     */
    private static function connectorSources(string $connectorId, ?array $connector): array
    {
        $sources = [];
        $auth = is_array($connector['authentication'] ?? null) ? $connector['authentication'] : [];

        foreach (['env_var_name' => 'env', 'constant_name' => 'constant', 'setting_name' => 'option'] as $key => $type) {
            if (! empty($auth[$key]) && is_string($auth[$key])) {
                $sources[] = ['type' => $type, 'name' => $auth[$key]];
            }
        }

        $normalized = str_replace('-', '_', $connectorId);
        $sources[] = ['type' => 'env', 'name' => strtoupper($normalized).'_API_KEY'];
        $sources[] = ['type' => 'constant', 'name' => strtoupper($normalized).'_API_KEY'];
        $sources[] = ['type' => 'option', 'name' => "connectors_ai_{$normalized}_api_key"];

        return array_values(array_unique($sources, SORT_REGULAR));
    }

    private static function readSource(string $type, string $name): ?string
    {
        return match ($type) {
            'env' => (($value = getenv($name)) !== false && $value !== '') ? (string) $value : null,
            'constant' => (defined($name) && constant($name)) ? (string) constant($name) : null,
            'option' => (($value = get_option($name)) && is_string($value)) ? $value : null,
            default => null,
        };
    }
}
