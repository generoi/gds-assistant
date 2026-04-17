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

    private const VERSION = 6;

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

    /**
     * Meta key storing the hash of the bundled prompt we installed. Used
     * to detect whether the user has customized the skill — if the stored
     * content still hashes to what we installed, it's safe to update; if
     * it doesn't, the user edited it and we leave it alone.
     */
    private const BUNDLED_HASH_META = '_assistant_bundled_hash';

    private static function installSkill(array $skill): void
    {
        $newHash = md5($skill['prompt']);

        $existing = get_posts([
            'post_type' => 'assistant_skill',
            'post_status' => 'any',
            'name' => $skill['slug'],
            'numberposts' => 1,
        ]);

        if (empty($existing)) {
            $postId = wp_insert_post([
                'post_type' => 'assistant_skill',
                'post_title' => $skill['title'],
                'post_name' => $skill['slug'],
                'post_content' => $skill['prompt'],
                'post_excerpt' => $skill['description'],
                'post_status' => 'publish',
            ]);
            if ($postId && ! is_wp_error($postId)) {
                update_post_meta($postId, self::BUNDLED_HASH_META, $newHash);
            }

            return;
        }

        // Skill exists. Only update if the current content matches the
        // hash we installed originally — i.e. user hasn't touched it.
        // Otherwise we'd clobber their customizations.
        $post = $existing[0];
        $installedHash = (string) get_post_meta($post->ID, self::BUNDLED_HASH_META, true);
        $currentHash = md5($post->post_content);

        if ($installedHash === '' || $installedHash !== $currentHash) {
            // Either never tracked (pre-meta install) or user-edited — leave it.
            return;
        }

        if ($installedHash === $newHash) {
            // Already up to date.
            return;
        }

        wp_update_post([
            'ID' => $post->ID,
            'post_title' => $skill['title'],
            'post_content' => $skill['prompt'],
            'post_excerpt' => $skill['description'],
        ]);
        update_post_meta($post->ID, self::BUNDLED_HASH_META, $newHash);
    }

    /**
     * @return array<int, array{slug: string, title: string, description: string, prompt: string}>
     */
    private static function skills(): array
    {
        return [
            [
                'slug' => 'audit-links',
                'title' => 'Link Quality Audit',
                'description' => 'Scan posts for link quality issues: placeholder hrefs (#, empty, javascript:), links to non-existent pages, language mismatches, and anchor text that doesn\'t match the target page.',
                'prompt' => self::linkQualityAuditPrompt(),
            ],
            [
                'slug' => 'create-content',
                'title' => 'Create Content (guided)',
                'description' => 'Guided content creation that matches existing site structure — finds similar posts, copies block/ACF structure, honors design tokens. Never creates without review.',
                'prompt' => self::createContentPrompt(),
            ],
            [
                'slug' => 'report-bug',
                'title' => 'Report Bug / Bad Session',
                'description' => 'Email the site administrator with a report about an assistant bug, bad response, or quality issue. Includes the conversation ID so the admin can look up the full session in the audit log.',
                'prompt' => self::reportBugPrompt(),
            ],
        ];
    }

    private static function linkQualityAuditPrompt(): string
    {
        return <<<'PROMPT'
Audit my site's internal link quality — flag sloppy/placeholder links and links where the anchor text doesn't match the target page. (This is NOT a 404 check on external URLs.)

**Before you start**, ask me:
- Which post types to scan?
- Scope: all, recent only (last 90 days), or drafts only?
- Language filter if the site is multilingual?

Then use `gds/content-list` with `_fields=id,title,status,link,content,lang` to pull everything in one paginated call. Warn me before proceeding if the result is >100 posts — large sets may need multi-pass review.

**For each link in each post**, extract from `<a href>` AND block attributes (button.url, image.link, ACF link fields). Categorize:

**Placeholder / broken** — report always:
- `href="#"` or `href=""` with no legitimate purpose
- `href="javascript:..."`
- `href="http://..."` on an https site (mixed-content risk)
- `?p=123` raw post IDs instead of pretty permalinks

**Internal dead links** — report always:
- Pointing to slugs that no longer exist (verify via `gds/content-list`)
- From published content, pointing to drafts/trashed posts

**Language mismatches** — multilingual sites only:
- Finnish post → English page when a Finnish translation exists (`gds/translations-create` or `gds/content-list` with `lang` confirms). Common oversight during translation.

**Semantic mismatches** — use your judgment:
- Anchor text vs. target page topic. "Read more about pricing" linking to `/about-us` is suspect.
- "Click here" / "more" / "here" anchors (a11y + SEO smell)
- CTA links in related-content sections pointing to unrelated pages

When in doubt, flag as "review needed" rather than silently passing.

**Report back** grouped by issue type, sorted by severity (dead > language > placeholder > anchor-smell). Example:

```
## Internal dead links (2)
- Post "Services" (id:456) — links to /old-page (404 — page doesn't exist)
- ...

## Language mismatches (5)
- /fi/palvelut (id:789) — "Our team" → /about-us (English). Finnish translation exists at /fi/tiimi (id:790).
- ...
```

Each item: post title + id, anchor text, href, and why it's flagged.

**Don't auto-fix anything.** After the report, offer:
- Suggest replacement URLs for dead links?
- Fix language-consistent URLs?
- Save as a draft report post?
- Fix a specific issue now? (will require per-change approval)

Never invent replacement URLs — only suggest pages that actually exist. For semantic items, explain your reasoning so I can judge. If the site has >100 posts, suggest batching by post type or date range.
PROMPT;
    }

    private static function createContentPrompt(): string
    {
        return <<<'PROMPT'
Help me create new content that matches the site's existing structure and style. Don't skip straight to creation — follow this:

**First, ask me**:
- Content type? (page, post, case study, service, product — use `gds/post-types-list` if unsure)
- Topic / subject?
- Which language(s)? (check available languages in the system prompt)
- Any specific reference page to mirror, or should you pick 2-3 similar ones?

Don't proceed until all four are clear.

**Then find 2-3 similar existing posts** via `gds/content-list` with `type=<post_type>`, `per_page=10`, `_fields=id,title,status,link`, relevant `search` term. Show me the candidates and confirm which to use as templates before reading them in full.

**Read each chosen template** with `gds/content-read` — get content, taxonomies, ACF fields, featured_media. Note:
- Block types used and in what order
- Common patterns (hero → intro → feature grid → CTA? heading hierarchy? word count per section?)
- ACF values populated (what kinds of stats, quotes, teaser images are typical?)

**Understand each block type** you plan to use via `gds/blocks-get` with `name=<block/name>`, `search_post_type=<post_type>`, `max_post_examples=3`, `include_examples=true`. Read the attribute schema, variations, and real examples. Never hallucinate block attributes — check the schema.

**Honor the site's design tokens** via `gds/theme-json` — color palette slugs, typography presets, spacing scale. Prefer slugs over raw values: `backgroundColor: "primary"` over `backgroundColor: "#0066cc"`.

**Check ACF fields** via `gds/acf-fields` with the post type filter — see what's required and what types. If templates had meaningful ACF values, propose similar for the new post.

**For multilingual sites**, ask if I want translations. Check whether a similar translated page exists (`gds/content-list` with `lang`). Use `gds/translations-create` to create linked translations — never invent translated content; ask me or copy from an existing translation.

**Draft but DO NOT create yet**. Propose:
- Title(s) and slug(s)
- Block-by-block outline (human-readable plan, not YAML/JSON)
- ACF field values
- Taxonomies
- Featured image plan

Wait for my approval. Then use `gds/content-create` with `status=draft` (never publish unless I explicitly say so). Returns new post ID + edit_url + preview_url.

**Constraints**:
- Plausible placeholder content is fine for drafts (client names, stats, testimonials, quotes, prices, dates) — but wrap each placeholder in `[brackets]` or prefix with `TODO:` so I can spot what needs filling in. Never present invented facts as real. Example: "Served [15+ Nordic retailers]" or "TODO: insert real client quote here".
- Never publish without explicit "publish it" from me. If any `[brackets]` / `TODO:` markers remain, remind me before publishing.
- Mirror, don't clone — body content should be new and relevant to the topic.
- Match the voice (formal/casual, first/third person) of the references.
- Ask when a structural gap is real (client quote, real stats). For demos/fictional topics, use `[placeholders]`.
- One draft first. Generate variations only after I see the first one.
PROMPT;
    }

    private static function reportBugPrompt(): string
    {
        return <<<'PROMPT'
I want to report a bug or quality issue with this assistant session. Please help me send a report to the site admin.

**First, check your tool list.** If `gds/mail-send` is NOT available, don't try to draft a report or use any other path — just tell me exactly:

> Bug reporting needs a standard or full tier model so the email draft is reliable. Please switch via the model selector at the bottom of the chat (e.g. Claude Sonnet, GPT-5.4 Mini, or Gemini Pro) and re-run `/report-bug`.

Then stop. Don't fabricate a report.

**If `gds/mail-send` IS available**, continue:

Ask me briefly: "Anything specific you want me to flag, or should I summarize what I noticed?" — if I've already described the issue in the conversation, skip asking. Don't dig further than one round, this is quick.

Then draft an email using `gds/mail-send`:
- **to**: the site admin email from the "## This conversation" section of your context (if missing, ask me)
- **subject**: `[AI Assistant] Bug: <one-line summary>` (≤70 chars)
- **body** (plain text, `html: false`):

```
# Assistant bug report

**Conversation ID:** <uuid from "## This conversation" in your context>
**Model:** <model key from footer, e.g. anthropic:sonnet>
**Time:** <current human-readable timestamp>

## What went wrong

<my description if provided, otherwise your concise summary>

## Recent exchange

**User:** <last user message, verbatim>

**Assistant:** <the problematic assistant response, truncated to ~500 chars if long>

<include one more turn above if it adds context, max 3 total>

## How to reproduce

Admin can view the full session via:
`wp gds-assistant audit show <uuid>`
```

I'll see the full email in the approval prompt before it sends. If I deny, don't argue — just acknowledge and ask what I'd like to change.

**Don't include sensitive data** I may not want shared (draft post contents, form submissions, customer PII, credentials) unless directly relevant to the bug. If unsure, leave it out and note "see audit log" instead. Keep it short — one issue per report. If you don't know what went wrong, say so honestly — the admin will look up the session via the UUID.
PROMPT;
    }
}
