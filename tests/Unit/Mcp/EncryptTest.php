<?php

namespace GeneroWP\Assistant\Tests\Unit\Mcp;

use GeneroWP\Assistant\Mcp\Encrypt;
use GeneroWP\Assistant\Tests\TestCase;

class EncryptTest extends TestCase
{
    public function test_encrypt_roundtrip(): void
    {
        $plaintext = 'sk-ant-api03-super-secret-token-value';
        $encrypted = Encrypt::encrypt($plaintext);

        $this->assertNotSame($plaintext, $encrypted);
        // Should be the versioned envelope form on a working WP environment.
        $this->assertMatchesRegularExpression('/^(v1|plain):/', $encrypted);

        $decrypted = Encrypt::decrypt($encrypted);
        $this->assertSame($plaintext, $decrypted);
    }

    public function test_distinct_encryptions_produce_distinct_ciphertexts(): void
    {
        // Each call uses a fresh IV — same plaintext must never produce the
        // same ciphertext (prevents trivial equality attacks in the DB).
        $plaintext = 'identical-input';
        $a = Encrypt::encrypt($plaintext);
        $b = Encrypt::encrypt($plaintext);

        if (str_starts_with($a, 'plain:') || str_starts_with($b, 'plain:')) {
            $this->markTestSkipped('Encryption falling back to plaintext — salts or openssl unavailable.');
        }

        $this->assertNotSame($a, $b);
        $this->assertSame($plaintext, Encrypt::decrypt($a));
        $this->assertSame($plaintext, Encrypt::decrypt($b));
    }

    public function test_decrypt_returns_null_for_garbage(): void
    {
        $this->assertNull(Encrypt::decrypt('not-an-envelope'));
        $this->assertNull(Encrypt::decrypt('v1:not-valid-base64!!!'));
    }

    public function test_encrypt_keys_only_wraps_listed_fields(): void
    {
        $data = [
            'access_token' => 'secret-a',
            'refresh_token' => 'secret-r',
            'expires_at' => 1234567890,
            'token_type' => 'Bearer',
        ];
        $encrypted = Encrypt::encryptKeys($data, ['access_token', 'refresh_token']);

        // Plaintext fields untouched.
        $this->assertSame(1234567890, $encrypted['expires_at']);
        $this->assertSame('Bearer', $encrypted['token_type']);
        // Secret fields wrapped.
        $this->assertNotSame('secret-a', $encrypted['access_token']);
        $this->assertNotSame('secret-r', $encrypted['refresh_token']);

        $decrypted = Encrypt::decryptKeys($encrypted, ['access_token', 'refresh_token']);
        $this->assertSame($data, $decrypted);
    }
}
