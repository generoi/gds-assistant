<?php

namespace GeneroWP\Assistant\Bridge;

use GeneroWP\Assistant\Api\ChatEndpoint;
use GeneroWP\Assistant\Llm\MessageLoop;

/**
 * Forces human approval for writes that are irreversible in practice, even
 * when the underlying ability isn't annotated `destructive`.
 *
 * Gravity Forms fields and taxonomy terms have NO revision history. A field
 * type change or a dropped field permanently orphans the submissions stored
 * for it, and there is only the nightly backup to fall back on. These
 * abilities classify as `moderate` and (for forms-update) are annotated
 * non-destructive, so without this guard {@see MessageLoop}
 * would execute them silently.
 *
 * Pairs with the data-layer guard in gds-mcp's GravityFormsAbility::updateForm(),
 * which refuses destructive field changes unless `confirm_destructive` is set.
 * When the user approves here, {@see ChatEndpoint}
 * injects that flag (see confirmOnApproval()) so the now human-confirmed call
 * passes the data-layer guard.
 */
class DestructiveGuard
{
    /**
     * Filter callback for `gds-assistant/tool_requires_approval`.
     *
     * @param  bool  $needsApproval  Decision so far (risk + destructive annotation).
     * @param  string  $abilityName  Resolved ability name, e.g. `gds/forms-update`.
     * @param  array  $input  Parsed tool input.
     */
    public static function requiresApproval(bool $needsApproval, string $abilityName, array $input): bool
    {
        if ($needsApproval) {
            return true;
        }

        // Rewriting a form's field structure can destroy submissions. Only
        // gate when the call actually replaces fields[] — title/notification/
        // confirmation edits stay frictionless.
        if ($abilityName === 'gds/forms-update' && array_key_exists('fields', $input)) {
            return true;
        }

        // Term edits are not revisioned; a rename or slug change is hard to undo.
        if ($abilityName === 'gds/terms-update') {
            return true;
        }

        // Editing a Gravity Forms feed silently rewrites an integration binding
        // (ActiveCampaign field mapping, webhook target) — leads can stop
        // flowing with no visible error. feeds-delete is already destructive.
        if ($abilityName === 'gds/feeds-update') {
            return true;
        }

        // Creating a redirect changes live URL routing and isn't revisioned.
        if ($abilityName === 'gds/redirects-manage' && ($input['action'] ?? '') === 'create') {
            return true;
        }

        // Memory is injected into the system prompt for every future
        // conversation. Gating saves blocks prompt-injected tool output from
        // silently persisting instructions ("memory poisoning").
        if ($abilityName === 'assistant/memory-save') {
            return true;
        }

        // Re-linking translations overwrites Polylang's translation group: a
        // post already linked elsewhere is silently orphaned, and changing a
        // post's language strips it from its group. No revisions, no visible
        // diff — it quietly breaks language switchers and hreflang.
        if ($abilityName === 'gds/translations-link') {
            return true;
        }

        // String translations are site-wide UI text with no revisions, and
        // machine translation can overwrite human-edited translations.
        if ($abilityName === 'gds/strings-update' || $abilityName === 'gds/translations-machine') {
            return true;
        }

        return false;
    }

    /**
     * Ability names whose data-layer guard accepts a `confirm_destructive`
     * flag. When the user approves one of these, the approval handler injects
     * the flag so the (now human-confirmed) call is allowed through. Filterable
     * so other ability providers can opt in.
     *
     * @return string[] Ability names (e.g. `gds/forms-update`).
     */
    public static function confirmOnApproval(): array
    {
        return apply_filters('gds-assistant/confirm_on_approval', ['gds/forms-update', 'gds/translations-link']);
    }

    /**
     * Add the human-approval confirmation flag to a tool's input when its
     * ability opts in. Called right before an approved tool re-executes.
     *
     * @param  string  $toolName  LLM tool name (e.g. `gds__forms-update`).
     * @param  array  $input  Original tool input.
     * @return array Input, possibly with `confirm_destructive` set.
     */
    public static function injectConfirmation(string $toolName, array $input): array
    {
        $abilityName = AbilitiesToolProvider::toAbilityName($toolName);
        if (in_array($abilityName, self::confirmOnApproval(), true)) {
            $input['confirm_destructive'] = true;
        }

        return $input;
    }
}
