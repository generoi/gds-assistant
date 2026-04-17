<?php

namespace GeneroWP\Assistant\Mcp;

/**
 * Envelope encryption for MCP credentials at rest.
 *
 * Key derivation is HKDF-SHA256 over `wp_salt('auth')` (AUTH_KEY + AUTH_SALT),
 * so ciphertexts travel with the site. Cipher is AES-256-GCM with a fresh
 * 12-byte IV per message. Output is `v1:<base64>` where the payload is
 * `iv || tag || ciphertext`.
 *
 * Caveat — this is defense in depth, not a boundary: an attacker with DB
 * access usually has wp-config.php too, and the key is derivable from it.
 * The point is to stop casual DB dumps/backups/logs from leaking usable
 * upstream-service tokens.
 */
class Encrypt
{
    private const VERSION = 'v1';

    private const CIPHER = 'aes-256-gcm';

    private const INFO = 'gds-assistant:mcp:v1';

    public static function encrypt(string $plaintext): string
    {
        $key = self::deriveKey();
        if ($key === null) {
            // Fall back to plaintext with a marker so decrypt() recognizes it.
            // Happens only on misconfigured WP installs without salts + without
            // OpenSSL — rare, but better than a fatal.
            return 'plain:'.base64_encode($plaintext);
        }

        $iv = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt($plaintext, self::CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($ciphertext === false) {
            return 'plain:'.base64_encode($plaintext);
        }

        return self::VERSION.':'.base64_encode($iv.$tag.$ciphertext);
    }

    public static function decrypt(string $envelope): ?string
    {
        if (str_starts_with($envelope, 'plain:')) {
            $decoded = base64_decode(substr($envelope, 6), true);

            return $decoded === false ? null : $decoded;
        }

        if (! str_starts_with($envelope, self::VERSION.':')) {
            return null;
        }

        $key = self::deriveKey();
        if ($key === null) {
            return null;
        }

        $payload = base64_decode(substr($envelope, strlen(self::VERSION) + 1), true);
        if ($payload === false || strlen($payload) < 28) {
            return null;
        }
        $iv = substr($payload, 0, 12);
        $tag = substr($payload, 12, 16);
        $ciphertext = substr($payload, 28);

        $plain = openssl_decrypt($ciphertext, self::CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag);

        return $plain === false ? null : $plain;
    }

    /** Transparently encrypt the given keys in an associative array. */
    public static function encryptKeys(array $data, array $keys): array
    {
        foreach ($keys as $key) {
            if (isset($data[$key]) && is_string($data[$key]) && $data[$key] !== '') {
                $data[$key] = self::encrypt($data[$key]);
            }
        }

        return $data;
    }

    /** Transparently decrypt the given keys in an associative array. */
    public static function decryptKeys(array $data, array $keys): array
    {
        foreach ($keys as $key) {
            if (isset($data[$key]) && is_string($data[$key])) {
                $plain = self::decrypt($data[$key]);
                // If decrypt() returns null the value was never encrypted (e.g.
                // pre-encryption data) or the salts changed. Leave it alone —
                // the caller will treat a bad token as "not connected" and the
                // user can reconnect.
                $data[$key] = $plain ?? $data[$key];
            }
        }

        return $data;
    }

    private static function deriveKey(): ?string
    {
        if (! function_exists('openssl_encrypt') || ! function_exists('hash_hkdf')) {
            return null;
        }
        $salt = function_exists('wp_salt') ? wp_salt('auth') : '';
        if ($salt === '' || $salt === false) {
            return null;
        }

        return hash_hkdf('sha256', $salt, 32, self::INFO);
    }
}
