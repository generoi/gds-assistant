/**
 * Block markup validation against the editor's own block registry.
 *
 * The only real validity check is Gutenberg's: parse the markup and run each
 * block's JS save() against what was stored (`wp.blocks.parse` sets
 * `isValid` + `validationIssues` per block). PHP can't do that, so the chat
 * does it in the browser wherever the full registry (core + the site's custom
 * blocks) is loaded, i.e. on block-editor screens.
 *
 * Gutenberg's validation log entries are printf-style `args` meant for the
 * console, and the catch-all "Block validation failed for …" entry dumps the
 * block type and both full markups. We drop that one and render the rest
 * compactly so the model gets a short, actionable reason.
 */

/** The subset of a parsed block this module reads. */
export interface ParsedBlock {
  name: string;
  isValid?: boolean;
  validationIssues?: Array<{ args?: unknown[] }>;
  attributes?: Record<string, unknown>;
  innerBlocks?: ParsedBlock[];
}

/** One problem found in parsed markup. */
export interface BlockIssue {
  /** Block name as written in the markup (the original name if unregistered). */
  name: string;
  /** 1-based, depth-first count of blocks with this name (gds/blocks-patch `occurrence`). */
  occurrence: number;
  /** 1-based position in the tree, e.g. "3.1" = first child of the third block. */
  path: string;
  reason: string;
}

interface BlocksApi {
  parse: (markup: string) => ParsedBlock[];
  getBlockType?: (name: string) => unknown;
}

const MISSING_BLOCK = "core/missing";
const MAX_REASON_LENGTH = 240;
const MAX_ARG_LENGTH = 80;

const blocksApi = (): BlocksApi | undefined =>
  (window as unknown as { wp?: { blocks?: BlocksApi } }).wp?.blocks;

/**
 * Whether this page has a block registry worth validating against: core
 * blocks registered (so it's an editor screen, where custom block scripts are
 * loaded too) and the unregistered-block fallback present.
 */
export function canValidateBlocks(): boolean {
  const api = blocksApi();
  return !!(
    api?.parse &&
    api.getBlockType?.("core/paragraph") &&
    api.getBlockType(MISSING_BLOCK)
  );
}

/**
 * Parse markup with the page's registry and return its block issues, or null
 * when the registry isn't available here (validation is skipped, not passed).
 * @param markup
 */
export function validateBlockMarkup(markup: string): BlockIssue[] | null {
  if (!canValidateBlocks()) {
    return null;
  }
  return collectBlockIssues(blocksApi()!.parse(markup || ""));
}

/**
 * Walk parsed blocks (recursively) and collect unregistered blocks and blocks
 * whose saved markup doesn't match their save() output.
 * @param blocks
 */
export function collectBlockIssues(blocks: ParsedBlock[]): BlockIssue[] {
  const issues: BlockIssue[] = [];
  const seen: Record<string, number> = {};

  const visit = (list: ParsedBlock[], prefix: string): void => {
    list.forEach((block, index) => {
      if (!block) {
        return;
      }
      const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      const missing = block.name === MISSING_BLOCK;
      const originalName = block.attributes?.originalName;
      const name =
        missing && typeof originalName === "string" ? originalName : block.name;
      seen[name] = (seen[name] || 0) + 1;

      if (missing) {
        issues.push({
          name,
          occurrence: seen[name],
          path,
          reason: "block type is not registered on this site",
        });
      } else if (block.isValid === false) {
        issues.push({
          name,
          occurrence: seen[name],
          path,
          reason: describeValidationIssues(block.validationIssues),
        });
      }
      visit(block.innerBlocks || [], path);
    });
  };

  visit(blocks || [], "");
  return issues;
}

/**
 * Short reason from Gutenberg's queued validation log entries, minus the
 * catch-all dump.
 * @param entries
 */
export function describeValidationIssues(
  entries: ParsedBlock["validationIssues"],
): string {
  const reasons = (entries || [])
    .map((entry) => entry?.args || [])
    .filter(
      (args) =>
        !(
          typeof args[0] === "string" &&
          args[0].includes("Block validation failed for")
        ),
    )
    .map(formatLogArgs)
    .filter(Boolean);
  const reason =
    [...new Set(reasons)].join(" ") ||
    "saved markup does not match what the block's save() outputs";
  return truncate(reason, MAX_REASON_LENGTH);
}

/**
 * Render console-style printf args (`%s`, `%o`, …) as one compact line.
 * @param args
 */
export function formatLogArgs(args: unknown[]): string {
  const [format, ...rest] = args;
  if (typeof format !== "string") {
    return collapse(args.map(compactValue).join(" "));
  }
  let i = 0;
  let text = format.replace(/%[sdifoOc%]/g, (token) => {
    if (token === "%%") {
      return "%";
    }
    if (i >= rest.length) {
      return token;
    }
    const value = rest[i++];
    return token === "%c" ? "" : compactValue(value);
  });
  if (i < rest.length) {
    text += ` ${rest.slice(i).map(compactValue).join(" ")}`;
  }
  return collapse(text);
}

/**
 * One line per issue for the model or the tool card, capped at `max`.
 * @param issues
 * @param max
 */
export function formatBlockIssues(issues: BlockIssue[], max = 10): string[] {
  const lines = issues
    .slice(0, max)
    .map(
      (issue) =>
        `${issue.name} (occurrence ${issue.occurrence}, block ${issue.path}): ${issue.reason}`,
    );
  if (issues.length > max) {
    lines.push(`…and ${issues.length - max} more`);
  }
  return lines;
}

function compactValue(value: unknown): string {
  if (typeof value === "string") {
    return truncate(collapse(value), MAX_ARG_LENGTH);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return String(value);
  }
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return truncate(json, MAX_ARG_LENGTH);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
