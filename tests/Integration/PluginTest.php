<?php

namespace GeneroWP\Assistant\Tests\Integration;

use GeneroWP\Assistant\Plugin;
use GeneroWP\Assistant\Storage\AuditLog;
use GeneroWP\Assistant\Storage\ConversationStore;
use GeneroWP\Assistant\Tests\TestCase;

class PluginTest extends TestCase
{
    public function test_post_type_assistant_skill_registered(): void
    {
        $this->assertTrue(post_type_exists('assistant_skill'));
    }

    public function test_post_type_assistant_memory_registered(): void
    {
        $this->assertTrue(post_type_exists('assistant_memory'));
    }

    public function test_skill_post_type_is_rest_enabled(): void
    {
        $pt = get_post_type_object('assistant_skill');
        $this->assertTrue($pt->show_in_rest);
        $this->assertSame('assistant-skills', $pt->rest_base);
    }

    public function test_memory_post_type_is_rest_enabled(): void
    {
        $pt = get_post_type_object('assistant_memory');
        $this->assertTrue($pt->show_in_rest);
        $this->assertSame('assistant-memory', $pt->rest_base);
    }

    public function test_post_types_are_not_public(): void
    {
        $skill = get_post_type_object('assistant_skill');
        $memory = get_post_type_object('assistant_memory');

        $this->assertFalse($skill->public);
        $this->assertFalse($memory->public);
    }

    public function test_conversations_table_created(): void
    {
        global $wpdb;

        ConversationStore::createTables();

        $tableName = ConversationStore::tableName();
        $exists = $wpdb->get_var("SHOW TABLES LIKE '{$tableName}'");

        $this->assertSame($tableName, $exists);
    }

    public function test_audit_log_table_created(): void
    {
        global $wpdb;

        AuditLog::createTables();

        $tableName = AuditLog::tableName();
        $exists = $wpdb->get_var("SHOW TABLES LIKE '{$tableName}'");

        $this->assertSame($tableName, $exists);
    }

    public function test_rest_routes_registered(): void
    {
        $routes = rest_get_server()->get_routes();

        $this->assertArrayHasKey('/gds-assistant/v1/chat', $routes);
        $this->assertArrayHasKey('/gds-assistant/v1/conversations', $routes);
        $this->assertArrayHasKey('/gds-assistant/v1/conversations/(?P<uuid>[a-f0-9-]+)', $routes);
    }

    public function test_cleanup_cron_scheduled_on_activation(): void
    {
        $plugin = Plugin::getInstance();
        $plugin->activate();

        $this->assertNotFalse(wp_next_scheduled('gds_assistant_cleanup'));
    }

    public function test_cleanup_cron_cleared_on_deactivation(): void
    {
        $plugin = Plugin::getInstance();
        $plugin->activate();
        $plugin->deactivate();

        $this->assertFalse(wp_next_scheduled('gds_assistant_cleanup'));
    }
}
