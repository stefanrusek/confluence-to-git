import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ConversionConfig } from "../src/types.ts";
import {
  STATE_FILE_NAME,
  STATE_SCHEMA_VERSION,
  deleteState,
  emptyInventory,
  loadState,
  markCompleted,
  newState,
  recordFailure,
  saveState,
  stateFileExists,
  stateFilePath,
} from "../src/state.ts";

let tmpDir: string;

const config: ConversionConfig = {
  confluenceUrl: "https://example.atlassian.net/wiki",
  outputDir: "/tmp/out",
  parallelism: 4,
};

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "c2g-state-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("newState", () => {
  test("produces empty completedPageIds and failedPageIds", () => {
    const state = newState(config, emptyInventory());
    expect(state.version).toBe(STATE_SCHEMA_VERSION);
    expect(state.progress.completedPageIds.size).toBe(0);
    expect(state.progress.failedPageIds.size).toBe(0);
    expect(typeof state.progress.startedAt).toBe("string");
    expect(typeof state.progress.lastUpdated).toBe("string");
  });
});

describe("markCompleted", () => {
  test("adds to the completed set", () => {
    const state = newState(config, emptyInventory());
    markCompleted(state, "page-1");
    expect(state.progress.completedPageIds.has("page-1")).toBe(true);
    expect(state.progress.completedPageIds.size).toBe(1);
  });

  test("marking a previously-failed page removes it from failures", () => {
    const state = newState(config, emptyInventory());
    recordFailure(state, "page-2", "boom");
    expect(state.progress.failedPageIds.has("page-2")).toBe(true);

    markCompleted(state, "page-2");
    expect(state.progress.completedPageIds.has("page-2")).toBe(true);
    expect(state.progress.failedPageIds.has("page-2")).toBe(false);
  });
});

describe("recordFailure", () => {
  test("records pageId -> reason in the map", () => {
    const state = newState(config, emptyInventory());
    recordFailure(state, "page-3", "network timeout");
    expect(state.progress.failedPageIds.get("page-3")).toBe("network timeout");
    expect(state.progress.failedPageIds.size).toBe(1);
  });
});

describe("saveState / loadState round-trip", () => {
  test("restores Set and Map contents exactly", async () => {
    const state = newState(config, emptyInventory());
    markCompleted(state, "p1");
    markCompleted(state, "p2");
    recordFailure(state, "p3", "reason-3");
    recordFailure(state, "p4", "reason-4");

    const dest = stateFilePath(tmpDir);
    await saveState(state, dest);

    const loaded = await loadState(dest);

    expect(loaded.version).toBe(STATE_SCHEMA_VERSION);
    expect(loaded.config).toEqual(config);

    expect(loaded.progress.completedPageIds.size).toBe(2);
    expect(loaded.progress.completedPageIds.has("p1")).toBe(true);
    expect(loaded.progress.completedPageIds.has("p2")).toBe(true);

    expect(loaded.progress.failedPageIds.size).toBe(2);
    expect(loaded.progress.failedPageIds.get("p3")).toBe("reason-3");
    expect(loaded.progress.failedPageIds.get("p4")).toBe("reason-4");

    expect(loaded.progress.completedPageIds).toBeInstanceOf(Set);
    expect(loaded.progress.failedPageIds).toBeInstanceOf(Map);
  });

  test("updates lastUpdated on save", async () => {
    const state = newState(config, emptyInventory());
    const before = state.progress.lastUpdated;
    // Ensure a later timestamp.
    await new Promise((r) => setTimeout(r, 5));
    const dest = stateFilePath(tmpDir);
    await saveState(state, dest);
    expect(state.progress.lastUpdated >= before).toBe(true);
  });
});

describe("saveState atomicity", () => {
  test("destination exists and no leftover .tmp-* files remain", async () => {
    const state = newState(config, emptyInventory());
    const dest = stateFilePath(tmpDir);
    await saveState(state, dest);

    expect(existsSync(dest)).toBe(true);

    const entries = readdirSync(tmpDir);
    const leftover = entries.filter((e) => e.includes(".tmp-"));
    expect(leftover).toEqual([]);
    expect(entries).toContain(STATE_FILE_NAME);
  });
});

describe("loadState errors", () => {
  test("throws on a missing file", async () => {
    const dest = stateFilePath(tmpDir);
    await expect(loadState(dest)).rejects.toThrow();
  });
});

describe("stateFileExists", () => {
  test("false before save, true after save", async () => {
    expect(stateFileExists(tmpDir)).toBe(false);
    await saveState(newState(config, emptyInventory()), stateFilePath(tmpDir));
    expect(stateFileExists(tmpDir)).toBe(true);
  });
});

describe("deleteState", () => {
  test("removes the file", async () => {
    await saveState(newState(config, emptyInventory()), stateFilePath(tmpDir));
    expect(stateFileExists(tmpDir)).toBe(true);
    await deleteState(tmpDir);
    expect(stateFileExists(tmpDir)).toBe(false);
  });

  test("is a no-op when absent", async () => {
    expect(stateFileExists(tmpDir)).toBe(false);
    await expect(deleteState(tmpDir)).resolves.toBeUndefined();
  });
});
