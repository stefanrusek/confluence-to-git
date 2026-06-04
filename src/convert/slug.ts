/**
 * Slug and repository-path construction.
 *
 * Rules (from the spec):
 *  - Lowercase, spaces -> hyphens
 *  - Keep alphanumeric, underscore and hyphen; everything else collapses to a hyphen
 *  - Collapse consecutive hyphens, trim leading/trailing hyphens
 *  - Max 200 chars
 *  - Collisions are resolved by appending `-{pageId}`
 */

const MAX_SLUG_LENGTH = 200;

/** Convert an arbitrary title into a filesystem-safe slug. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    // Replace any run of disallowed chars (anything not a-z, 0-9, _ or -) with a hyphen.
    .replace(/[^a-z0-9_-]+/g, "-")
    // Collapse repeated hyphens.
    .replace(/-+/g, "-")
    // Trim leading/trailing hyphens.
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, MAX_SLUG_LENGTH) || "untitled";
}

/**
 * Build the repo-relative path (within a space) from the ancestor chain and
 * the page title, e.g. (["Parent","Child"], "Grandchild") -> "parent/child/grandchild.md".
 */
export function buildPath(ancestors: string[], title: string): string {
  const dirs = ancestors.map(slugify).filter((s) => s.length > 0);
  const file = `${slugify(title)}.md`;
  return [...dirs, file].join("/");
}

/**
 * Full repo path for a page: the space key is the top-level directory (kept
 * verbatim, as Confluence space keys are already filesystem-safe), followed by
 * the slugified ancestor/title path.
 */
export function pagePath(spaceKey: string, ancestors: string[], title: string): string {
  return `${spaceKey}/${buildPath(ancestors, title)}`;
}

/** Directory (within a space) that holds a page's attachments. */
export function attachmentsDir(spaceKey: string, ancestors: string[]): string {
  const dirs = ancestors.map(slugify).filter((s) => s.length > 0);
  return [spaceKey, ...dirs, "attachments"].join("/");
}

/**
 * Attachment filename: `{pageSlug}_{originalFileName}`. The original file name
 * (including its extension) is preserved verbatim.
 */
export function attachmentName(pageSlug: string, fileName: string): string {
  return `${pageSlug}_${fileName}`;
}

/**
 * Resolve a slug against the set of slugs already taken (per directory). If the
 * base slug is free it is returned and reserved; otherwise `-{pageId}` is
 * appended to guarantee uniqueness.
 */
export function resolveSlugCollision(
  baseSlug: string,
  pageId: string,
  taken: Set<string>,
): string {
  if (!taken.has(baseSlug)) {
    taken.add(baseSlug);
    return baseSlug;
  }
  const unique = `${baseSlug}-${pageId}`;
  taken.add(unique);
  return unique;
}
