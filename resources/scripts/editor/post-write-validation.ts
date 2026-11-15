/**
 * Validate posts that server-side abilities just wrote.
 *
 * gds-mcp abilities run in PHP inside the chat stream, so the browser only
 * learns about a write from its tool_result. After the stream ends we fetch
 * each written post's saved markup, validate it with the editor registry
 * ({@link ./block-validation}), and hand any problems back to the model as a
 * follow-up message so it fixes them.
 */

import {
  formatBlockIssues,
  validateBlockMarkup,
  canValidateBlocks,
  type BlockIssue,
} from "./block-validation";

/** Abilities that write post content (block markup). */
const CONTENT_WRITE_ABILITIES = new Set([
  "gds/content-create",
  "gds/content-update",
  "gds/blocks-patch",
  "gds/content-replace",
]);

/** Prefix of the follow-up message, so it's recognisable in the thread. */
export const VALIDATION_NOTE_PREFIX = "⚠ Block validation:";

const positiveInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

/**
 * Post ids a successful tool result wrote content to, or [] for anything that
 * isn't a content write (other tools, dry runs, no-op replaces).
 * @param toolName "gds/content-update" or "gds__content-update"
 * @param result   the tool result payload
 */
export function writtenPostIds(toolName: string, result: unknown): number[] {
  const name = (toolName || "").replace("__", "/");
  if (!CONTENT_WRITE_ABILITIES.has(name)) {
    return [];
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const r = result as Record<string, unknown>;
  if (r.error || r.dry_run) {
    return [];
  }
  if (name === "gds/content-replace") {
    if (Array.isArray(r.posts)) {
      return r.posts
        .filter(
          (p): p is Record<string, unknown> =>
            !!p && typeof p === "object" && !p.error && Number(p.matched) > 0,
        )
        .map((p) => positiveInt(p.id))
        .filter((id): id is number => id !== null);
    }
    if (Number(r.replaced_count) === 0) {
      return [];
    }
  }
  // Templates carry a composite string `id` and the numeric post in `wp_id`.
  const id = positiveInt(r.wp_id) ?? positiveInt(r.id);
  return id ? [id] : [];
}

/**
 * Fetch a post's saved markup and validate it. Null when this page can't
 * validate (no editor registry) or the fetch failed — callers skip, they
 * don't treat that as valid or invalid.
 * @param postId
 */
export async function validateSavedPost(
  postId: number,
): Promise<BlockIssue[] | null> {
  if (!canValidateBlocks()) {
    return null;
  }
  const { restUrl, nonce } = window.gdsAssistant || {};
  try {
    const response = await fetch(`${restUrl}block-markup/${postId}`, {
      headers: { "X-WP-Nonce": nonce || "" },
    });
    if (!response.ok) {
      return null;
    }
    const data: { content?: unknown } = await response.json();
    return typeof data.content === "string"
      ? validateBlockMarkup(data.content)
      : null;
  } catch {
    return null;
  }
}

/**
 * The follow-up message that tells the model what to fix.
 * @param reports post id → its issues (only posts with issues)
 */
export function buildValidationFollowUp(
  reports: Array<{ postId: number; issues: BlockIssue[] }>,
): string {
  const sections = reports.map(
    ({ postId, issues }) =>
      `Post #${postId}:\n${formatBlockIssues(issues)
        .map((line) => `- ${line}`)
        .join("\n")}`,
  );
  return [
    `${VALIDATION_NOTE_PREFIX} the saved content has blocks the block editor flags as "unexpected or invalid content".`,
    ...sections,
    "Fix each block so its markup matches what the block's save() outputs (gds/blocks-patch with block_name + occurrence), or replace unregistered blocks with registered ones (gds/block-types-list). Don't resend the same markup.",
  ].join("\n\n");
}
