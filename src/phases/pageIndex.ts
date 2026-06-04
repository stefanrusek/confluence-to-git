/**
 * Builds the global map of page title -> repo path used to rewrite internal
 * links, and resolves collisions deterministically.
 */
import { posix as posixPath } from "node:path";
import { pagePath } from "../convert/slug.ts";
import type { ConversionInventory } from "../types.ts";

export interface PageLocation {
  pageId: string;
  repoPath: string;
  spaceKey: string;
  ancestorTitles: string[];
}

export class PageIndex {
  private readonly byTitle = new Map<string, string>();
  private readonly byId = new Map<string, PageLocation>();

  static build(inventory: ConversionInventory): PageIndex {
    const index = new PageIndex();
    const takenPaths = new Set<string>();
    for (const entry of inventory.pages) {
      const ancestorTitles = entry.page.ancestors.map((a) => a.title);
      let repoPath = pagePath(entry.spaceKey, ancestorTitles, entry.page.title);
      if (takenPaths.has(repoPath)) {
        repoPath = repoPath.replace(/\.md$/, `-${entry.page.id}.md`);
      }
      takenPaths.add(repoPath);
      index.byTitle.set(entry.page.title, repoPath);
      index.byId.set(entry.page.id, {
        pageId: entry.page.id,
        repoPath,
        spaceKey: entry.spaceKey,
        ancestorTitles,
      });
    }
    return index;
  }

  location(pageId: string): PageLocation | undefined {
    return this.byId.get(pageId);
  }

  /** Resolve a relative markdown link from `fromRepoPath` to the page titled `title`. */
  relativeLink(fromRepoPath: string, title: string): string | undefined {
    const target = this.byTitle.get(title);
    if (!target) return undefined;
    let rel = posixPath.relative(posixPath.dirname(fromRepoPath), target);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return rel;
  }
}
