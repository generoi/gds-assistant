<?php

namespace GeneroWP\Assistant\Tests\Unit\Bridge;

use GeneroWP\Assistant\Bridge\DefaultSkills;
use GeneroWP\Assistant\Tests\TestCase;

/**
 * Guards the duplicate-skill self-heal: a concurrent install once created two
 * byte-identical `report-bug` posts sharing a slug. collapseDuplicates() must
 * fold those back to one while never touching a genuinely customized copy.
 */
class DefaultSkillsTest extends TestCase
{
    /**
     * Create an assistant_skill post and force its slug directly. Sequential
     * wp_insert_post() can't produce two posts with the same post_name (WP's
     * wp_unique_post_slug appends -2), so we bypass it to recreate the race.
     */
    private function forceSkill(string $slug, string $content): int
    {
        $id = (int) wp_insert_post([
            'post_type' => 'assistant_skill',
            'post_title' => 'Skill',
            'post_content' => $content,
            'post_status' => 'publish',
        ]);

        global $wpdb;
        $wpdb->update($wpdb->posts, ['post_name' => $slug], ['ID' => $id]);
        clean_post_cache($id);

        return $id;
    }

    private function collapse(string $slug): ?\WP_Post
    {
        $method = new \ReflectionMethod(DefaultSkills::class, 'collapseDuplicates');
        $method->setAccessible(true);

        return $method->invoke(null, $slug);
    }

    public function test_collapses_identical_duplicates_to_the_lowest_id(): void
    {
        $first = $this->forceSkill('race', 'identical body');
        $second = $this->forceSkill('race', 'identical body');

        $canonical = $this->collapse('race');

        $this->assertSame($first, $canonical->ID, 'keeps the original (lowest ID)');
        $this->assertInstanceOf(\WP_Post::class, get_post($first));
        $this->assertNull(get_post($second), 'removes the byte-identical extra');
    }

    public function test_preserves_a_customized_duplicate(): void
    {
        $first = $this->forceSkill('race2', 'original body');
        $customized = $this->forceSkill('race2', 'a user edited this copy');

        $canonical = $this->collapse('race2');

        $this->assertSame($first, $canonical->ID);
        $this->assertInstanceOf(
            \WP_Post::class,
            get_post($customized),
            'a duplicate with different content is never silently deleted',
        );
    }

    public function test_returns_null_when_no_post_exists(): void
    {
        $this->assertNull($this->collapse('does-not-exist'));
    }
}
