/**
 * Phase 3: Finalize. Generate README + migration report, commit them, and
 * remove the state file on success.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GitRepo } from "../git/repo.ts";
import { deleteState } from "../state.ts";
import type { ConversionState, GitAuthor, Logger } from "../types.ts";
import type { ImportResult } from "./import.ts";

const TOOL_AUTHOR: GitAuthor = {
  name: "confluence-to-git",
  email: "confluence-to-git@local",
};

export interface FinalizeOptions {
  /** Wall-clock duration of the run in seconds. */
  durationSeconds: number;
}

export async function finalizePhase(
  state: ConversionState,
  outputDir: string,
  result: ImportResult,
  logger: Logger,
  options: FinalizeOptions,
): Promise<void> {
  logger.info("Phase 3: Finalizing");

  const readme = renderReadme(state);
  const report = renderReport(state, result, options);

  await writeFile(join(outputDir, "README.md"), readme, "utf-8");
  await writeFile(join(outputDir, "MIGRATION_REPORT.md"), report, "utf-8");
  logger.info("Generated README.md and MIGRATION_REPORT.md");

  const repo = new GitRepo(outputDir, logger);
  await repo.commitPaths(["README.md", "MIGRATION_REPORT.md"], {
    author: TOOL_AUTHOR,
    date: new Date(),
    message: "Confluence migration: add README and migration report",
  });

  if (result.pagesFailed === 0) {
    await deleteState(outputDir);
    logger.info("Cleanup successful, state file removed");
  } else {
    logger.warn(
      `Preserving state file: ${result.pagesFailed} page(s) failed. Re-run to retry.`,
    );
  }
}

function renderReadme(state: ConversionState): string {
  const { inventory, config } = state;
  return `# Confluence Migration to Git

**Source**: ${config.confluenceUrl}
**Migrated**: ${new Date().toISOString()}
**Pages**: ${inventory.totalPages}
**Spaces**: ${inventory.spaces.length}

## Repository Structure

- Each Confluence **space** is a top-level directory (named by space key)
- Each Confluence **page** is a Markdown file (\`.md\`)
- **Comments** are preserved in \`.comments.json\` sidecar files
- **Attachments** are in \`attachments/\` directories next to their page
- **History** is preserved in git commit history (one commit per Confluence version)

## Key Conventions

- Page titles are slugified (e.g. "API Reference" -> \`api-reference.md\`)
- Nested pages preserve hierarchy (e.g. "Parent > Child" -> \`parent/child.md\`)
- Internal links are rewritten to relative paths
- Unsupported Confluence macros are preserved as commented HTML

## Git History

Each commit represents a version from Confluence, preserving the original
author (mapped to a git author/email), timestamp, and version message.

## Migration Report

See \`MIGRATION_REPORT.md\` for detailed statistics and any errors encountered.
`;
}

function renderReport(
  state: ConversionState,
  result: ImportResult,
  options: FinalizeOptions,
): string {
  const { inventory } = state;
  const imported = result.pagesImported;
  const failed = state.progress.failedPageIds.size;
  const total = inventory.totalPages;
  const rate = total > 0 ? ((imported / total) * 100).toFixed(1) : "0.0";

  const failedRows =
    failed === 0
      ? "_None_"
      : [...state.progress.failedPageIds.entries()]
          .map(([pageId, reason]) => {
            const entry = inventory.pages.find((p) => p.page.id === pageId);
            const title = entry?.page.title ?? pageId;
            const space = entry?.spaceKey ?? "?";
            return `| ${title} | ${space} | ${reason} |`;
          })
          .join("\n");

  return `# Migration Report

**Date**: ${new Date().toISOString()}
**Duration**: ${options.durationSeconds}s

## Summary

| Metric | Count |
|--------|-------|
| Total Pages | ${total} |
| Imported Successfully | ${imported} |
| Failed | ${failed} |
| Success Rate | ${rate}% |
| Total Attachments | ${inventory.totalAttachments} |
| Spaces | ${inventory.spaces.length} |
| Git Commits | ${result.totalCommits} |

## Failed Pages

| Page Title | Space | Reason |
|-----------|-------|--------|
${failedRows}

## Next Steps

1. Review failed pages above.
2. Re-run the tool to retry failed pages (the state file is preserved on failure).
3. Inspect \`.comments.json\` files for Confluence comments.
4. Verify attachment links and internal links.
`;
}
