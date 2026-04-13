<?php

namespace GeneroWP\Assistant\Tests;

use WP_UnitTestCase;

class TestCase extends WP_UnitTestCase
{
    protected function createEditorUser(): int
    {
        return self::factory()->user->create(['role' => 'editor']);
    }

    protected function createAdminUser(): int
    {
        return self::factory()->user->create(['role' => 'administrator']);
    }
}
