<?php

namespace GeneroWP\Assistant\Bridge;

/**
 * Bundled default skills installed on plugin activation / upgrade.
 *
 * Each skill is a slash-command prompt template stored as an
 * `assistant_skill` post. Users can customize them like any other skill —
 * we only install if the slug doesn't exist, so manual edits survive.
 *
 * Bump VERSION to re-run install and add new bundled skills. Existing
 * user-customized skills with matching slugs are NOT overwritten.
 */
class DefaultSkills
{
    private const VERSION_OPTION = 'gds_assistant_default_skills_version';

    private const VERSION = 1;

    public static function maybeInstall(): void
    {
        $installed = (int) get_option(self::VERSION_OPTION, 0);
        if ($installed >= self::VERSION) {
            return;
        }

        foreach (self::skills() as $skill) {
            self::installSkill($skill);
        }

        update_option(self::VERSION_OPTION, self::VERSION);
    }

    private static function installSkill(array $skill): void
    {
        // Skip if a skill with this slug already exists — preserves
        // user customizations across upgrades.
        $existing = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'any',
            'name' => $skill['slug'],
            'numberposts' => 1,
            'fields' => 'ids',
        ]);
        if (! empty($existing)) {
            return;
        }

        wp_insert_post([
            'post_type' => 'assistant_skill',
            'post_title' => $skill['title'],
            'post_name' => $skill['slug'],
            'post_content' => $skill['prompt'],
            'post_excerpt' => $skill['description'],
            'post_status' => 'publish',
        ]);
    }

    /**
     * @return array<int, array{slug: string, title: string, description: string, prompt: string}>
     */
    private static function skills(): array
    {
        return [
            [
                'slug' => 'audit-links',
                'title' => 'Broken Link Audit',
                'description' => 'Scan posts for broken external links. Warns before auditing large sets and offers to scope by post type or recency.',
                'prompt' => self::brokenLinkAuditPrompt(),
            ],
            [
                'slug' => 'create-content',
                'title' => 'Create Content (guided)',
                'description' => 'Guided content creation that matches existing site structure — finds similar posts, copies block/ACF structure, honors design tokens. Never creates without review.',
                'prompt' => self::createContentPrompt(),
            ],
        ];
    }

    private static function brokenLinkAuditPrompt(): string
    {
        return <<<'PROMPT'
Run a broken-link audit on this site's content. Follow this procedure strictly.

## 1. Scope the audit first — DO NOT skip this step

Before listing posts, clarify scope with the user:
- Which post types? (ask if unclear — offer the site's actual public post types from the context)
- All posts, or filter by status/date range? (recent-only = last 90 days is a reasonable default for large sites)
- Any language filter (if the site is multilingual)?
- Maximum number of posts to scan (default: 50)

Then use `gds/content-list` with `_fields=id,title,status,link,date` to get the candidate posts.

**Warn the user before proceeding if the candidate set is larger than 100 posts.** Each post requires one content-read + one web-fetch per unique link. Show the estimated count and ask for confirmation.

## 2. Extract and deduplicate links

For each post:
1. Use `gds/content-read` to get the content (request `_fields=id,title,content,link` to limit payload)
2. Extract all `https?://...` URLs from the rendered content AND from block attributes (href, url, link.url fields — parsing block JSON if needed)
3. Skip:
   - Internal links (same host as the site)
   - Media library links (`/wp-content/uploads/`)
   - Mailto, tel, javascript, anchor-only (#...)
   - URLs already checked in this session

Maintain a running map of `url → { status, posts_containing_it }` so each unique URL is fetched exactly once.

## 3. Check each unique URL

Use `gds/web-fetch` with `format=text` and `max_length=500` — we only need the status code and title, not the full page. On each check:
- 200 → OK
- 3xx following to 200 → OK (but note redirect chains >2 hops)
- 4xx/5xx or timeout → broken

Batch sensibly — if there are 50+ unique URLs, warn the user and confirm before continuing.

## 4. Report findings

Present results as a markdown table:
| Status | URL | Found in |
|--------|-----|----------|
| 404 | https://example.com/broken | Post A (id:123), Post B (id:456) |

Group by status code. Sort by most-referenced broken URL first.

**Do NOT auto-fix anything.** Offer next steps:
- "Want me to draft replacement URLs for any of these?"
- "Want me to save this report as a draft post?" (if yes, create a draft with gds/content-create — requires approval)
- "Want to re-check specific URLs after you've updated them?"

## Constraints

- Never edit post content without the user reviewing each change individually
- Don't invent URLs — if a link is broken, say so and ask the user what to replace it with
- Keep report concise — don't repeat the same broken URL under each post it appears in
PROMPT;
    }

    private static function createContentPrompt(): string
    {
        return <<<'PROMPT'
Create new site content by matching the structure, style, and conventions of existing content. Follow this procedure strictly — NEVER skip straight to creation.

## 1. Clarify the ask

Before any tool calls, confirm with the user:
- **What type** of content? (page, post, case study, service, product — use `gds/post-types-list` if unsure which are available)
- **What topic / subject** is it about?
- **Which language(s)** should it exist in? (check available languages in the system prompt context)
- **Any reference** they want us to mirror? (URL of a similar page, or they can say "pick 2-3 similar")

Do not proceed until all four are clear.

## 2. Find similar existing content (at least 2-3 examples)

Use `gds/content-list` with `type=<post_type>`, `per_page=10`, `_fields=id,title,status,link`, and a relevant `search` term. Pick 2-3 PUBLISHED items that best match the topic.

Show the user the candidates and confirm which ones to use as templates before reading them in full.

## 3. Read the templates deeply

For each chosen reference:
- `gds/content-read` with `type=<post_type>` and `id=<id>` — get full content, taxonomies, ACF fields, featured_media
- Note which block types appear (parse the wp:block comments in content.rendered, or use the block structure if returned)
- Note common patterns: hero → intro → feature grid → CTA? Heading hierarchy? Typical word count per section?
- Note ACF field values — what kinds of statistics, quotes, teaser images are usually populated?

## 4. Understand the blocks before using them

For EACH block type you plan to use:
- `gds/blocks-get` with `name=<block/name>`, `search_post_type=<post_type>`, `max_post_examples=3`, `include_examples=true`
- Read the attribute schema (types, defaults, enums)
- Read the variations — many blocks have official variations that change style/layout
- Read the examples — see how real site content uses the block

**Never hallucinate block attributes.** If unsure whether a block supports a given prop, check the schema.

## 5. Understand the site's design tokens

Use `gds/theme-json` (or the equivalent resource) to find:
- Color palette slugs (use these, not hex values, so theme updates flow through)
- Font sizes / typography presets
- Spacing scale

Prefer slugs over raw values: `backgroundColor: "primary"` over `backgroundColor: "#0066cc"`.

## 6. Understand the content type's ACF fields (if any)

`gds/acf-fields` with the post type filter — see what fields exist, whether they're required, their types (text, repeater, image, etc.). If the template posts had meaningful ACF values, propose similar structure for the new post.

## 7. Check for multilingual requirements

If the site has multiple languages:
- Ask the user if they want translations created
- Check whether a translation of a similar page exists in the target language (via `gds/content-list` with `lang` filter)
- Use `gds/translations-create` to create linked translations if requested — NEVER invent translated content; ask the user for translated titles/copy or copy from an existing translation template

## 8. Draft — DO NOT create yet

Propose the draft to the user:
- Title(s)
- Slug(s)
- Block-by-block outline showing which block types, with what content (still as text, not YAML/JSON — a human-readable plan)
- ACF field values (if applicable)
- Taxonomies (services, industries, tags)
- Featured image plan (existing media ID, new upload, or TBD)

Wait for user approval or revisions.

## 9. Create (with approval)

Use `gds/content-create` (status=draft by default — NEVER publish unless explicitly asked). Returns the new post ID + edit_url + preview_url.

If ACF fields were specified, they're set in the same call via the `fields` parameter.

If translations were requested, use `gds/translations-create` to link them — copies the source + creates linked translations.

## Constraints

- **Never invent factual content** — company names, statistics, testimonials, product specs, prices, dates. Ask the user or copy from reference posts.
- **Never publish without explicit "publish it" from the user.** Always draft first.
- **Mirror, don't clone** — match the structure and style, but the content should be new and relevant to the topic at hand.
- **Match the voice of existing content.** Formal vs. casual, first vs. third person — infer from the references and stay consistent.
- **Flag gaps.** If a reference post has a testimonial but you don't have one for the new topic, ask the user — don't fabricate.
- Create ONE draft first. If the user wants variations, generate them AFTER seeing the first one.
PROMPT;
    }
}
