<?php

namespace GeneroWP\Assistant\Tests\Unit\Mcp;

use GeneroWP\Assistant\Mcp\OAuthAuth;
use GeneroWP\Assistant\Tests\TestCase;
use ReflectionMethod;

class OAuthAuthTest extends TestCase
{
    /**
     * RFC 7636 Appendix B known-answer test for S256 PKCE challenge derivation.
     * If this fails, clients can't exchange auth codes — catastrophic.
     */
    public function test_pkce_challenge_matches_rfc7636_appendix_b(): void
    {
        $method = new ReflectionMethod(OAuthAuth::class, 'pkceChallenge');
        $method->setAccessible(true);

        $verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        $expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

        $this->assertSame($expectedChallenge, $method->invoke(null, $verifier));
    }

    public function test_random_url_safe_uses_unreserved_characters(): void
    {
        $method = new ReflectionMethod(OAuthAuth::class, 'randomUrlSafe');
        $method->setAccessible(true);

        $out = $method->invoke(null, 32);
        // base64url alphabet + no padding.
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9_-]+$/', $out);
        $this->assertStringNotContainsString('=', $out);
    }

    public function test_random_url_safe_produces_distinct_values(): void
    {
        $method = new ReflectionMethod(OAuthAuth::class, 'randomUrlSafe');
        $method->setAccessible(true);

        $a = $method->invoke(null, 32);
        $b = $method->invoke(null, 32);

        $this->assertNotSame($a, $b);
    }
}
