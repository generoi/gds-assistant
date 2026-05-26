<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\DestructiveGuard;
use GeneroWP\Assistant\Tests\TestCase;

class DestructiveGuardTest extends TestCase
{
    public function test_forms_update_requires_approval_when_fields_present(): void
    {
        $this->assertTrue(
            DestructiveGuard::requiresApproval(false, 'gds/forms-update', ['id' => 1, 'fields' => []]),
            'A forms-update that replaces fields[] must be gated for approval.',
        );
    }

    public function test_forms_update_no_approval_for_non_field_edits(): void
    {
        $this->assertFalse(
            DestructiveGuard::requiresApproval(false, 'gds/forms-update', ['id' => 1, 'title' => 'New title']),
            'Editing only the title (no fields[]) should stay frictionless.',
        );
    }

    public function test_terms_update_always_requires_approval(): void
    {
        $this->assertTrue(
            DestructiveGuard::requiresApproval(false, 'gds/terms-update', ['id' => 5, 'name' => 'X']),
            'Term edits are not revisioned, so they must be gated.',
        );
    }

    public function test_existing_decision_is_never_downgraded(): void
    {
        $this->assertTrue(
            DestructiveGuard::requiresApproval(true, 'gds/content-update', []),
            'If risk classification already required approval, the guard must keep it.',
        );
    }

    public function test_unrelated_tools_are_untouched(): void
    {
        $this->assertFalse(DestructiveGuard::requiresApproval(false, 'gds/content-update', ['id' => 1]));
        $this->assertFalse(DestructiveGuard::requiresApproval(false, 'gds/posts-list', []));
    }

    public function test_inject_confirmation_for_forms_update(): void
    {
        $input = DestructiveGuard::injectConfirmation('gds__forms-update', ['id' => 1, 'fields' => []]);
        $this->assertTrue($input['confirm_destructive'] ?? null);
    }

    public function test_inject_confirmation_skips_other_tools(): void
    {
        $input = DestructiveGuard::injectConfirmation('gds__content-update', ['id' => 1]);
        $this->assertArrayNotHasKey('confirm_destructive', $input);
    }

    public function test_confirm_on_approval_is_filterable(): void
    {
        add_filter('gds-assistant/confirm_on_approval', fn ($list) => array_merge($list, ['gds/terms-update']));

        $input = DestructiveGuard::injectConfirmation('gds__terms-update', ['id' => 1]);
        $this->assertTrue($input['confirm_destructive'] ?? null);

        remove_all_filters('gds-assistant/confirm_on_approval');
    }

    public function test_feeds_update_requires_approval(): void
    {
        $this->assertTrue(DestructiveGuard::requiresApproval(false, 'gds/feeds-update', ['id' => 1]));
    }

    public function test_redirects_create_requires_approval_but_list_does_not(): void
    {
        $this->assertTrue(
            DestructiveGuard::requiresApproval(false, 'gds/redirects-manage', ['action' => 'create', 'from' => '/a', 'to' => '/b']),
            'Creating a redirect changes live routing — gate it.',
        );
        $this->assertFalse(
            DestructiveGuard::requiresApproval(false, 'gds/redirects-manage', ['action' => 'list']),
            'Listing redirects is read-only — no approval.',
        );
    }

    public function test_memory_save_requires_approval(): void
    {
        $this->assertTrue(
            DestructiveGuard::requiresApproval(false, 'assistant/memory-save', ['title' => 'x', 'content' => 'y']),
            'Memory persists into every future system prompt — gate it against poisoning.',
        );
    }

    public function test_translations_link_requires_approval(): void
    {
        $this->assertTrue(DestructiveGuard::requiresApproval(false, 'gds/translations-link', ['translations' => []]));
    }

    public function test_string_and_machine_translation_require_approval(): void
    {
        $this->assertTrue(DestructiveGuard::requiresApproval(false, 'gds/strings-update', ['string' => 'x']));
        $this->assertTrue(DestructiveGuard::requiresApproval(false, 'gds/translations-machine', ['post_id' => 1]));
    }

    public function test_translations_link_is_in_confirm_on_approval(): void
    {
        $this->assertContains('gds/translations-link', DestructiveGuard::confirmOnApproval());

        $input = DestructiveGuard::injectConfirmation('gds__translations-link', ['translations' => ['en' => 1, 'fi' => 2]]);
        $this->assertTrue($input['confirm_destructive'] ?? null);
    }

    public function test_content_delete_is_no_longer_gated_on_force(): void
    {
        // force is removed entirely from content-delete; the guard no longer
        // special-cases it (deletes are trash-only now).
        $this->assertFalse(DestructiveGuard::requiresApproval(false, 'gds/content-delete', ['type' => 'posts', 'id' => 1, 'force' => true]));
    }
}
