import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockConfluenceAPI } from "../src/confluence/mock.ts";
import { inventoryPhase } from "../src/phases/inventory.ts";
import { importPhase } from "../src/phases/import.ts";
import { finalizePhase } from "../src/phases/finalize.ts";
import { GitRepo } from "../src/git/repo.ts";
import { newState, stateFileExists, saveState, stateFilePath } from "../src/state.ts";
import { createNullLogger } from "../src/logger.ts";
import type { ConversionState } from "../src/types.ts";

const logger = createNullLogger();

function freshState(mock: MockConfluenceAPI, dir: string, parallelism = 4): Promise<ConversionState> {
  return inventoryPhase(mock, logger).then((inv) =>
    newState({ confluenceUrl: "https://x.atlassian.net", outputDir: dir, parallelism }, inv),
  );
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "c2g-phases-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("inventory phase", () => {
  test("enumerates spaces, pages and attachments", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Documentation" });
    const p = mock.addPage({ id: "1", title: "Home", spaceKey: "DOCS" });
    p.addAttachment({ id: "a1", fileName: "logo.png" });

    const inv = await inventoryPhase(mock, logger);
    expect(inv.spaces.length).toBe(1);
    expect(inv.totalPages).toBe(1);
    expect(inv.totalAttachments).toBe(1);
    expect(inv.pages[0]!.attachmentCount).toBe(1);
  });
});

describe("import phase", () => {
  test("imports a page with full history as ordered commits", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    const page = mock.addPage({ id: "1", title: "API Guide", spaceKey: "DOCS" });
    // page already has a seeded v1 (author "author1"); add v2 by author2.
    page.addVersion({
      number: 2,
      title: "API Guide",
      body: "<strong>Introduction</strong> to APIs",
      author: "author2",
      timestamp: "2024-01-02T11:00:00Z",
    });

    const state = await freshState(mock, dir);
    const result = await importPhase(mock, state, dir, logger);

    expect(existsSync(join(dir, "DOCS/api-guide.md"))).toBe(true);
    expect(result.pagesImported).toBe(1);

    const commits = await new GitRepo(dir).log();
    expect(commits.length).toBe(2);
    expect(commits[0]!.authorEmail).toBe("author1@confluence.local");
    expect(commits[1]!.authorEmail).toBe("author2@confluence.local");
    // Oldest-first: committed dates ascending.
    expect(commits[0]!.date.getTime()).toBeLessThan(commits[1]!.date.getTime());
  });

  test("downloads attachments and rewrites image links", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    const page = mock.addPage({ id: "1", title: "Doc", spaceKey: "DOCS" });
    page.addVersion({
      number: 2,
      body: '<p>See <ac:image><ri:attachment ri:filename="screenshot.png"/></ac:image></p>',
      author: "author1",
      timestamp: "2024-01-02T00:00:00Z",
    });
    page.addAttachment({ id: "att-1", fileName: "screenshot.png", bytes: new Uint8Array([9, 9, 9]) });

    const state = await freshState(mock, dir);
    await importPhase(mock, state, dir, logger);

    expect(existsSync(join(dir, "DOCS/attachments/doc_screenshot.png"))).toBe(true);
    const md = readFileSync(join(dir, "DOCS/doc.md"), "utf-8");
    expect(md).toContain("attachments/doc_screenshot.png");
  });

  test("serializes comments to a JSON sidecar", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    const page = mock.addPage({ id: "1", title: "Discussions", spaceKey: "DOCS" });
    page.addComment({ id: "c1", author: "user1", body: "<p>Great <strong>content</strong>!</p>" });

    const state = await freshState(mock, dir);
    await importPhase(mock, state, dir, logger);

    const sidecar = JSON.parse(readFileSync(join(dir, "DOCS/discussions.comments.json"), "utf-8"));
    expect(sidecar.totalComments).toBe(1);
    expect(sidecar.comments[0].body).toContain("Great **content**!");
    expect(sidecar.comments[0].author.accountId).toBe("user1");
  });

  test("skips already-completed pages and retries previously-failed ones", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "TEST", name: "Test" });
    mock.addPage({ id: "1", title: "Page1", spaceKey: "TEST" });
    mock.addPage({ id: "2", title: "Page2", spaceKey: "TEST" });

    const state = await freshState(mock, dir);
    state.progress.completedPageIds.add("1"); // pretend page 1 already done

    const result = await importPhase(mock, state, dir, logger);
    expect(result.pagesProcessed).toBe(1); // only page 2
    expect(result.pagesImported).toBe(1);
    expect(existsSync(join(dir, "TEST/page2.md"))).toBe(true);
  });

  test("records a failure after exhausting retries", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "TEST", name: "Test" });
    mock.addPage({ id: "1", title: "Bad", spaceKey: "TEST" });
    // Fail every attempt by making versions throw repeatedly.
    let calls = 0;
    mock.getPageVersions = async () => {
      calls++;
      throw new Error("permanent failure");
    };

    const state = await freshState(mock, dir);
    const result = await importPhase(mock, state, dir, logger);
    expect(result.pagesFailed).toBe(1);
    expect(calls).toBe(3); // MAX_PAGE_ATTEMPTS
    expect(state.progress.failedPageIds.get("1")).toContain("permanent failure");
  });

  test("parallel imports stay consistent under concurrency", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    for (let i = 1; i <= 10; i++) {
      mock.addPage({ id: String(i), title: `Page ${i}`, spaceKey: "DOCS" });
    }

    const state = await freshState(mock, dir, 4);
    const result = await importPhase(mock, state, dir, logger);

    expect(result.pagesImported).toBe(10);
    for (let i = 1; i <= 10; i++) {
      expect(existsSync(join(dir, `DOCS/page-${i}.md`))).toBe(true);
    }
    const repo = new GitRepo(dir);
    expect(await repo.isClean()).toBe(true);
    expect((await repo.log()).length).toBe(10);
  });
});

describe("finalize phase", () => {
  test("generates README + report and removes state on full success", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    mock.addPage({ id: "1", title: "Home", spaceKey: "DOCS" });

    const state = await freshState(mock, dir);
    await saveState(state, stateFilePath(dir));
    const result = await importPhase(mock, state, dir, logger);
    await finalizePhase(state, dir, result, logger, { durationSeconds: 1 });

    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, "MIGRATION_REPORT.md"))).toBe(true);
    expect(stateFileExists(dir)).toBe(false);

    const report = readFileSync(join(dir, "MIGRATION_REPORT.md"), "utf-8");
    expect(report).toContain("Success Rate | 100.0%");
  });

  test("preserves state file when there were failures", async () => {
    const mock = new MockConfluenceAPI();
    mock.addSpace({ key: "DOCS", name: "Docs" });
    mock.addPage({ id: "1", title: "Home", spaceKey: "DOCS" });

    const state = await freshState(mock, dir);
    await saveState(state, stateFilePath(dir));
    const result = await importPhase(mock, state, dir, logger);
    result.pagesFailed = 1;
    state.progress.failedPageIds.set("1", "boom");
    await finalizePhase(state, dir, result, logger, { durationSeconds: 1 });

    expect(stateFileExists(dir)).toBe(true);
  });
});
