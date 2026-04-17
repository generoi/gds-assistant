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

    private const VERSION = 5;

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
Audit the quality of internal links across this site's content. This is NOT about HTTP 404 checks on external URLs — it's about finding sloppy/placeholder links and links that point to pages that don't make sense for the anchor text.

## 1. Scope the audit first — DO NOT skip this step

Before listing posts, confirm with the user:
- Which post types? (offer the site's public post types — use `gds/post-types-list` if unsure)
- Scope: all, recent only (last 90 days), or drafts only?
- Language filter if multilingual?

Use `gds/content-list` with `_fields=id,title,status,link,content,lang` (fetches rendered content inline — no per-post reads needed). Paginate as needed.

**Warn the user before proceeding if the candidate set is larger than 100 posts.** The issue isn't tool cost (content comes back inline) but LLM context — very large sets may need multi-pass review. Ask if they want to limit scope or proceed in batches.

## 2. Categorize every link

For each post's rendered content (and block attributes), extract all links — both `<a href>` and block attributes like `button.url`, `image.link`, ACF link fields. For each link, classify:

**Placeholder / broken** (report always):
- `href="#"` or `href=""` with no legitimate purpose (intentional JS-handled links rare — flag them for review)
- `href="javascript:..."`
- `href="http://..."` when the site uses https (mixed-content risk)
- Trailing-slash inconsistencies on known routes
- URLs with `?p=123` (raw post IDs) when a pretty permalink exists

**Internal dead links** (report always):
- Links to the site's own domain pointing to a slug that no longer exists (check via `gds/content-list` with search/slug, or try a targeted `gds/content-read`). Cache lookups so we don't re-query the same slug.
- Links to pages with status != publish (drafts/trash) from published content

**Language mismatches** (multilingual sites only):
- A Finnish post linking to an English page when a Finnish translation exists (`gds/translations-create` or `gds/content-list` with `lang` can confirm). Often an oversight during translation.

**Semantic mismatches** (the judgment call — use LLM reasoning here):
- Anchor text vs. target page topic. "Read more about pricing" linking to `/about-us` is suspect.
- "Click here" / "more" / "here" anchors — flag as low-quality even if the target is fine (a11y + SEO smell)
- CTA links on related sections that point to unrelated landing pages

When in doubt, surface it as a "review needed" item rather than silently passing it.

## 3. Report findings

Group by issue type, sort by severity (dead > language mismatch > placeholder > anchor-text smell):

```
## Placeholder / dead hrefs (3)
- Post "Pricing" (id:123) — <a href="#">Learn more</a> — anchor: "Learn more", href is placeholder
- ...

## Internal dead links (2)
- Post "Services" (id:456) — links to /old-page (404 — page doesn't exist)
- ...

## Language mismatches (5)
- /fi/palvelut (id:789) — link "Our team" → /about-us (English). Finnish translation exists at /fi/tiimi (id:790).
- ...

## Semantic review needed (6)
- Post "Blog post" (id:901) — "Read our case study" → /about. Should this be a specific case, or the main about page?
- ...
```

For each item, include: post title + id, the anchor text, the href, and why it's flagged.

## 4. Offer next steps

**Do NOT auto-fix anything.** Offer:
- "Want me to suggest replacement URLs for the internal dead links?"
- "Want me to propose corrected language-consistent URLs?" (use the translations tools to find the right target)
- "Want me to save this audit as a draft report post?"
- "Should I fix a specific issue now?" (will require approval per fix)

## Constraints

- Don't rewrite post content without per-change approval
- For semantic-mismatch items, explain your reasoning ("anchor says X, target page is about Y") so the user can judge
- Never invent replacement URLs — only suggest pages that actually exist (verified via gds/content-list)
- If the site has >100 posts, suggest running the audit in batches by post type or date range — don't try to reason about 500 posts at once
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

- **Mark invented facts clearly.** Plausible placeholder content is fine for drafts (client names, statistics, testimonials, quotes, prices, dates) as long as you wrap each placeholder in `[brackets]` or prefix with `TODO:`. Never present invented facts as real — the reviewer needs to see at a glance which parts need human verification before publish. Example: "Served [15+ Nordic retailers]" or "TODO: insert real client quote here".
- **Never publish without explicit "publish it" from the user.** Always draft first. If any `[brackets]` / `TODO:` markers remain, remind the user to fill them in before publishing.
- **Mirror, don't clone** — match the structure and style, but the body content should be new and relevant to the topic at hand.
- **Match the voice of existing content.** Formal vs. casual, first vs. third person — infer from the references and stay consistent.
- **Ask first when the gap is structural.** If a reference post has a "Client quote" section and this is a real client engagement, ask for the quote. If it's a demo / fictional topic, use `[placeholder quote]` and continue.
- Create ONE draft first. If the user wants variations, generate them AFTER seeing the first one.
PROMPT;
    }

    private static function reportBugPrompt(): string
    {
        return <<<'PROMPT'
Report a bug, bad session, or quality issue to the site administrator.

Use this when:
- The user says "this isn't working", "bad response", "that was wrong", "/report-bug", etc.
- You (the assistant) recognize the session went badly (hallucinated IDs/titles, stuck in a loop, contradicted the user, misunderstood a basic request repeatedly)

## 1. Get the complaint

If the user already described what went wrong, use their words. Otherwise ASK ONCE briefly: "Anything specific you want me to flag, or should I summarize what I noticed?" — don't dig further than one round, this is a quick reporting flow.

## 2. Draft the email

Recipient: the site admin email from the "## This conversation" section of your context. If it's missing, stop and ask the user for an address.

Subject format: `[AI Assistant] Bug: <one-line summary>` (≤70 chars)

Body (markdown):

```
# Assistant bug report

**Conversation ID:** <uuid from "## This conversation" in your context>
**Model:** <model key from footer, e.g. anthropic:sonnet>
**Time:** <current human-readable timestamp>

## What went wrong

<user's description if provided, otherwise your concise summary>

## Recent exchange

**User:** <last user message, verbatim>

**Assistant:** <the problematic assistant response, truncated to ~500 chars if long>

<include one more turn above if it adds context, max 3 total>

## How to reproduce

Admin can view the full session via:
`wp gds-assistant audit show <uuid>`
```

## 3. Send

Use `gds/mail-send`:
- `to`: [<admin email>]
- `subject`: the line above
- `body`: the markdown above (plain text is fine — `html: false`)

The user will see the full email in the approval prompt. Let them approve or deny — do not argue if they deny.

### If gds/mail-send is not available

Some weaker/cheaper models don't have access to `gds/mail-send` (the tool is restricted to standard-tier and above because drafting coherent email requires reliable instruction-following). If you look at your tool list and don't see `gds/mail-send`, DO NOT try to send the report some other way. Instead, tell the user exactly this:

> Bug reporting needs a standard or full tier model so the email draft is reliable. Please switch via the model selector at the bottom of the chat (e.g. Claude Sonnet, GPT-5.4 Mini, or Gemini Flash) and re-run `/report-bug`.

Then stop. Don't fabricate a report or try a workaround.

## Constraints

- **ALWAYS go through gds/mail-send**, never some other path.
- **Do NOT include sensitive data** the user may not want shared (draft post contents, form submissions, customer PII, credentials) unless directly relevant to the bug. If unsure, leave it out and note "see audit log" instead.
- **Don't embellish.** If you don't know what went wrong, say so — the admin will look up the session via the UUID.
- **Keep it short.** One issue per report. Admins triage many of these; brevity helps.
- If the admin email isn't in your context, ASK for it instead of guessing.
PROMPT;
    }
}
