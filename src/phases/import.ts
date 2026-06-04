/**
 * Phase 2: Import (parallelized). Each page is an atomic unit: its full version
 * history becomes git commits, its attachments are downloaded, and its comments
 * are serialized to a JSON sidecar. Completed pages are recorded in the state so
 * re-runs skip them.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix as posixPath } from "node:path";
import type { ConfluenceClient } from "../confluence/client.ts";
import { GitRepo } from "../git/repo.ts";
import { UserMap, toGitAuthor } from "../users.ts";
import { convertStorageToMarkdown } from "../convert/markdown.ts";
import { attachmentName, slugify } from "../convert/slug.ts";
import { markCompleted, recordFailure } from "../state.ts";
import { PageIndex } from "./pageIndex.ts";
import type { ConversionState, GitAuthor, Logger } from "../types.ts";

const MAX_PAGE_ATTEMPTS = 3;
const STATE_FLUSH_INTERVAL = 50;

export interface ImportResult {
  /** Pages attempted this run (excludes already-completed skips). */
  pagesProcessed: number;
  /** Pages newly completed this run. */
  pagesImported: number;
  /** Pages that failed after retries. */
  pagesFailed: number;
  totalCommits: number;
}

export interface ImportHooks {
  /** Persist the current state (called periodically and on failure). */
  saveState?: () => Promise<void>;
}

export async function importPhase(
  client: ConfluenceClient,
  state: ConversionState,
  outputDir: string,
  logger: Logger,
  hooks: ImportHooks = {},
): Promise<ImportResult> {
  logger.info(`Phase 2: Importing pages (parallelism=${state.config.parallelism})`);

  const repo = new GitRepo(outputDir, logger);
  await repo.init();

  const userMap = new UserMap();
  const index = PageIndex.build(state.inventory);

  const pending = state.inventory.pages.filter(
    (e) => !state.progress.completedPageIds.has(e.page.id),
  );

  const result: ImportResult = {
    pagesProcessed: 0,
    pagesImported: 0,
    pagesFailed: 0,
    totalCommits: 0,
  };
  let processedSinceFlush = 0;

  const importOne = async (pageId: string, title: string): Promise<void> => {
    const location = index.location(pageId);
    if (!location) throw new Error(`Page ${pageId} not in index`);
    const { repoPath } = location;
    const pageSlug = slugify(title);
    const pageDir = posixPath.dirname(repoPath);

    const versions = await client.getPageVersions(pageId);
    if (versions.length === 0) {
      logger.warn("Page has no versions, skipping content", { pageId, title });
    }
    for (const v of versions) if (v.author) userMap.record(v.author);

    // One commit per version, oldest-first.
    for (const version of versions) {
      const { markdown, warnings } = convertStorageToMarkdown(version.storage, {
        pageSlug,
        resolvePageLink: (t) => index.relativeLink(repoPath, t),
        resolveAttachment: (file) => `attachments/${attachmentName(pageSlug, file)}`,
      });
      for (const w of warnings) logger.debug(`[${title}] ${w}`);

      await writeRepoFile(outputDir, repoPath, withFrontMatter(title, version.number, markdown));
      const author = version.author ? toGitAuthor(version.author) : userMap.toGitAuthorById(version.authorId);
      const message = version.message?.trim()
        ? version.message
        : `Page: ${title}, Version ${version.number}`;
      await repo.commitPaths([repoPath], { author, date: version.created, message });
      result.totalCommits++;
    }

    // Attachments + comments -> a single trailing commit (only if any exist).
    const attachments = await client.getAttachments(pageId);
    const comments = await client.getComments(pageId);
    const extraPaths: string[] = [];

    for (const att of attachments) {
      try {
        const bytes = await client.downloadAttachment(att);
        const rel = posixPath.join(pageDir, "attachments", attachmentName(pageSlug, att.fileName));
        await writeRepoBytes(outputDir, rel, bytes);
        extraPaths.push(rel);
      } catch (err) {
        logger.warn("Attachment download failed", {
          pageId,
          file: att.fileName,
          error: (err as Error).message,
        });
      }
    }

    if (comments.length > 0) {
      const rel = posixPath.join(pageDir, `${pageSlug}.comments.json`);
      await writeRepoFile(outputDir, rel, serializeComments(pageId, title, comments));
      extraPaths.push(rel);
    }

    if (extraPaths.length > 0) {
      const last = versions[versions.length - 1];
      const author: GitAuthor = last?.author
        ? toGitAuthor(last.author)
        : { name: "confluence-to-git", email: "confluence-to-git@local" };
      await repo.commitPaths(extraPaths, {
        author,
        date: last?.created ?? new Date().toISOString(),
        message: `Add attachments and comments for ${title}`,
      });
      result.totalCommits++;
    }
  };

  const worker = async (pageId: string, title: string): Promise<void> => {
    result.pagesProcessed++;
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_PAGE_ATTEMPTS; attempt++) {
      try {
        await importOne(pageId, title);
        markCompleted(state, pageId);
        result.pagesImported++;
        logger.debug("Imported page", { pageId, title });
        break;
      } catch (err) {
        lastError = (err as Error).message;
        logger.error(`Page import failed (attempt ${attempt}/${MAX_PAGE_ATTEMPTS})`, {
          pageId,
          title,
          error: lastError,
        });
        if (attempt === MAX_PAGE_ATTEMPTS) {
          recordFailure(state, pageId, lastError);
          result.pagesFailed++;
          if (hooks.saveState) await hooks.saveState();
        }
      }
    }

    processedSinceFlush++;
    if (processedSinceFlush >= STATE_FLUSH_INTERVAL && hooks.saveState) {
      processedSinceFlush = 0;
      await hooks.saveState();
    }
  };

  await runPool(pending, state.config.parallelism, (entry) =>
    worker(entry.page.id, entry.page.title),
  );

  if (hooks.saveState) await hooks.saveState();
  logger.info(
    `Import complete: ${result.pagesImported} imported, ${result.pagesFailed} failed, ${result.totalCommits} commits`,
  );
  return result;
}

// --- helpers ---------------------------------------------------------------

function withFrontMatter(title: string, version: number, markdown: string): string {
  // Lightweight front matter so titles with special characters survive slugging.
  return `---\ntitle: ${JSON.stringify(title)}\nversion: ${version}\n---\n\n${markdown}`;
}

function serializeComments(
  pageId: string,
  pageTitle: string,
  comments: import("../types.ts").ConfluenceComment[],
): string {
  const out = {
    pageId,
    pageTitle,
    comments: comments.map((c) => {
      const author = toGitAuthor(c.createdBy);
      return {
        id: c.id,
        author: { name: author.name, email: author.email, accountId: c.createdBy.accountId },
        createdDate: c.createdDate,
        updatedDate: c.updatedDate,
        body: convertStorageToMarkdown(c.body.storage.value).markdown.trim(),
        ...(c.restrictions
          ? {
              restrictions: {
                update: (c.restrictions.update ?? []).map((u) => u.user.accountId),
              },
            }
          : {}),
      };
    }),
    totalComments: comments.length,
  };
  return JSON.stringify(out, null, 2) + "\n";
}

async function writeRepoFile(outputDir: string, relPath: string, content: string): Promise<void> {
  const abs = join(outputDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf-8");
}

async function writeRepoBytes(outputDir: string, relPath: string, bytes: Uint8Array): Promise<void> {
  const abs = join(outputDir, relPath);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}
