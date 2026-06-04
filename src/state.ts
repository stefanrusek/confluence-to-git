/**
 * Resumable conversion state management.
 *
 * Persists a {@link ConversionState} to a JSON file (`.confluence-import-state.json`)
 * inside the output directory so that interrupted imports can be resumed. Handles
 * the JSON (de)serialization quirks for `Set`/`Map` fields and writes atomically.
 */

import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ConversionConfig,
  ConversionInventory,
  ConversionState,
} from "./types.ts";

export const STATE_FILE_NAME = ".confluence-import-state.json";
export const STATE_SCHEMA_VERSION = "1";

/** Build the absolute path to the state file inside an output directory. */
export function stateFilePath(outputDir: string): string {
  return path.resolve(outputDir, STATE_FILE_NAME);
}

/** Create a fresh empty inventory (zeroed counts, createdAt=now). */
export function emptyInventory(): ConversionInventory {
  return {
    spaces: [],
    pages: [],
    totalPages: 0,
    totalAttachments: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Create a fresh state with empty progress (startedAt/lastUpdated=now). */
export function newState(
  config: ConversionConfig,
  inventory: ConversionInventory,
): ConversionState {
  const now = new Date().toISOString();
  return {
    version: STATE_SCHEMA_VERSION,
    inventory,
    progress: {
      completedPageIds: new Set<string>(),
      failedPageIds: new Map<string, string>(),
      startedAt: now,
      lastUpdated: now,
    },
    config,
  };
}

/** Returns true if a state file exists in the given output directory. */
export function stateFileExists(outputDir: string): boolean {
  return existsSync(stateFilePath(outputDir));
}

/** On-disk representation of {@link ConversionState} with Set/Map flattened. */
interface SerializedState {
  version: string;
  inventory: ConversionInventory;
  progress: {
    completedPageIds: string[];
    failedPageIds: Array<[string, string]>;
    startedAt: string;
    lastUpdated: string;
  };
  config: ConversionConfig;
}

/**
 * Load and deserialize state from a state-file path.
 * Must correctly restore completedPageIds (Set) and failedPageIds (Map).
 * Throws a clear Error if the file is missing or schema version mismatches.
 */
export async function loadState(
  stateFilePathArg: string,
): Promise<ConversionState> {
  let raw: string;
  try {
    raw = await readFile(stateFilePathArg, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`State file not found: ${stateFilePathArg}`);
    }
    throw err;
  }

  let parsed: SerializedState;
  try {
    parsed = JSON.parse(raw) as SerializedState;
  } catch (err) {
    throw new Error(
      `Failed to parse state file ${stateFilePathArg}: ${(err as Error).message}`,
    );
  }

  if (parsed.version !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `State file schema version mismatch in ${stateFilePathArg}: ` +
        `expected "${STATE_SCHEMA_VERSION}", found "${parsed.version}"`,
    );
  }

  return {
    version: parsed.version,
    inventory: parsed.inventory,
    progress: {
      completedPageIds: new Set<string>(parsed.progress.completedPageIds ?? []),
      failedPageIds: new Map<string, string>(parsed.progress.failedPageIds ?? []),
      startedAt: parsed.progress.startedAt,
      lastUpdated: parsed.progress.lastUpdated,
    },
    config: parsed.config,
  };
}

/**
 * Serialize and save state ATOMICALLY: write to a temp file in the same
 * directory then rename over the destination (rename is atomic on POSIX).
 * Updates state.progress.lastUpdated to now before writing.
 * Serialize Set as an array, Map as an array of [key, value] pairs.
 */
export async function saveState(
  state: ConversionState,
  stateFilePathArg: string,
): Promise<void> {
  state.progress.lastUpdated = new Date().toISOString();

  const serialized: SerializedState = {
    version: state.version,
    inventory: state.inventory,
    progress: {
      completedPageIds: [...state.progress.completedPageIds],
      failedPageIds: [...state.progress.failedPageIds.entries()],
      startedAt: state.progress.startedAt,
      lastUpdated: state.progress.lastUpdated,
    },
    config: state.config,
  };

  const json = JSON.stringify(serialized, null, 2);
  const tmpPath = `${stateFilePathArg}.tmp-${process.pid}-${Date.now()}`;

  try {
    await writeFile(tmpPath, json, "utf8");
    await rename(tmpPath, stateFilePathArg);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename never happened.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Mark a page id completed (and remove it from failures if present). */
export function markCompleted(state: ConversionState, pageId: string): void {
  state.progress.completedPageIds.add(pageId);
  state.progress.failedPageIds.delete(pageId);
}

/** Record a page failure with a reason. */
export function recordFailure(
  state: ConversionState,
  pageId: string,
  reason: string,
): void {
  state.progress.failedPageIds.set(pageId, reason);
}

/** Delete the state file for an output directory (no error if absent). */
export async function deleteState(outputDir: string): Promise<void> {
  await unlink(stateFilePath(outputDir)).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw err;
  });
}
