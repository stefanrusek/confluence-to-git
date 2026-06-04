import type { ConfluenceUser, GitAuthor } from "./types.ts";

const FALLBACK_DOMAIN = "confluence.local";

/**
 * Map a single Confluence user to a git author.
 *
 * Rules:
 *  - name  = user.displayName || user.publicName || user.accountId
 *  - email = user.email when present and non-empty,
 *            otherwise `${user.accountId}@confluence.local`
 *  - If user is undefined/null (unknown author), return a generic
 *    { name: "Unknown", email: "unknown@confluence.local" }.
 */
export function toGitAuthor(user: ConfluenceUser | undefined | null): GitAuthor {
  if (!user) {
    return { name: "Unknown", email: `unknown@${FALLBACK_DOMAIN}` };
  }

  const name = user.displayName || user.publicName || user.accountId;
  const email =
    user.email && user.email.length > 0
      ? user.email
      : `${user.accountId}@${FALLBACK_DOMAIN}`;

  return { name, email };
}

/**
 * Accumulates user records seen during inventory/import so authors can later
 * be resolved by accountId (e.g. when a page version only carries authorId).
 */
export class UserMap {
  private readonly users = new Map<string, ConfluenceUser>();

  /** Record a user so it can be resolved later by accountId. Last write wins. */
  record(user: ConfluenceUser): void {
    this.users.set(user.accountId, user);
  }

  /** Number of distinct users recorded. */
  get size(): number {
    return this.users.size;
  }

  /**
   * Resolve a git author by accountId. If the accountId was recorded, map that
   * user. Otherwise synthesize a fallback author:
   *   name  = fallbackDisplayName ?? accountId
   *   email = `${accountId}@confluence.local`
   */
  toGitAuthorById(accountId: string, fallbackDisplayName?: string): GitAuthor {
    const user = this.users.get(accountId);
    if (user) {
      return toGitAuthor(user);
    }

    return {
      name: fallbackDisplayName ?? accountId,
      email: `${accountId}@${FALLBACK_DOMAIN}`,
    };
  }

  /** Raw lookup; undefined if not recorded. */
  get(accountId: string): ConfluenceUser | undefined {
    return this.users.get(accountId);
  }
}
