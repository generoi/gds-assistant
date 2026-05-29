/**
 * Skills are the user-defined prompt templates the assistant offers via the
 * `/slug` slash-command in the composer and lists in the Skills side panel.
 *
 * Cached in-memory because two distinct components (the autocomplete dropdown
 * and the skills panel) ask for the same list, and we don't want them racing
 * REST round-trips on first render. Cache TTL is short (30 s) so newly
 * authored skills appear without a hard refresh.
 *
 * Seeded synchronously from `window.gdsAssistant.skills` (PHP-injected on
 * page load) so the dropdown has something to show before the first fetch
 * resolves.
 */

export interface Skill {
  id: number;
  slug: string;
  title: string;
  description: string;
  prompt: string;
}

/** Raw skill row as returned by the REST API; trimmed by {@link getSkillsFresh}. */
interface RestSkillRow {
  id: number;
  slug: string;
  title?: { rendered?: string } | string;
  excerpt?: { rendered?: string };
  content?: { raw?: string; rendered?: string };
}

let skillsCache: Skill[] = window.gdsAssistant?.skills || [];
let skillsFetchedAt = 0;

/**
 * Return the cached list synchronously. Use this for first-paint of UI that
 * can re-render once {@link getSkillsFresh} resolves.
 */
export function getSkills(): Skill[] {
  return skillsCache;
}

/**
 * Return the freshest list, hitting the REST endpoint at most every 30 s.
 * Falls back to the cache silently on network errors so the UI stays
 * functional offline / when the endpoint is misbehaving.
 */
export async function getSkillsFresh(): Promise<Skill[]> {
  const now = Date.now();
  if (now - skillsFetchedAt < 30000 && skillsCache.length > 0) {
    return skillsCache;
  }
  try {
    const { restBase, nonce } = window.gdsAssistant || {};
    const response = await fetch(
      `${restBase}assistant-skills?per_page=100&status=publish&context=edit`,
      { headers: { "X-WP-Nonce": nonce || "" } },
    );
    if (response.ok) {
      const posts = (await response.json()) as RestSkillRow[];
      skillsCache = posts.map((p) => ({
        id: p.id,
        slug: p.slug,
        title:
          typeof p.title === "string" ? p.title : p.title?.rendered || "",
        description: p.excerpt?.rendered?.replace(/<[^>]*>/g, "").trim() || "",
        // Use raw content (preserves markdown/formatting) when available
        prompt:
          p.content?.raw ||
          p.content?.rendered?.replace(/<[^>]*>/g, "").trim() ||
          "",
      }));
      skillsFetchedAt = now;
    }
  } catch {
    // Use cached data
  }
  return skillsCache;
}
