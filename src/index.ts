#!/usr/bin/env bun
/**
 * confluence-to-git entry point. Orchestrates the three-phase model
 * (inventory -> import -> finalize) with fresh/resume detection and the exit
 * codes defined by the specification.
 */
import { mkdir } from "node:fs/promises";
import { parseArgs, helpText, CliError } from "./cli.ts";
import { createLogger } from "./logger.ts";
import { HttpConfluenceClient } from "./confluence/client.ts";
import { inventoryPhase } from "./phases/inventory.ts";
import { importPhase } from "./phases/import.ts";
import { finalizePhase } from "./phases/finalize.ts";
import {
  newState,
  loadState,
  saveState,
  stateFileExists,
  stateFilePath,
} from "./state.ts";
import { ExitCode, type ConversionState, type Logger } from "./types.ts";

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}\n`);
      console.error(helpText());
      return ExitCode.FatalError;
    }
    throw err;
  }

  if (parsed.help || !parsed.options) {
    console.log(helpText());
    return ExitCode.Success;
  }

  const opts = parsed.options;
  await mkdir(opts.outputDir, { recursive: true });

  const logger = createLogger(
    { verbose: opts.verbose, debug: opts.debug, outputDir: opts.outputDir },
    [opts.apiToken],
  );

  const startedAt = Date.now();
  try {
    const client = new HttpConfluenceClient({
      baseUrl: opts.confluenceUrl,
      apiToken: opts.apiToken,
      logger,
    });

    const statePath = stateFilePath(opts.outputDir);
    let state: ConversionState;

    if (stateFileExists(opts.outputDir)) {
      logger.info("Resuming from existing state file");
      state = await loadState(statePath);
      validateResume(state, opts, logger);
      logger.info(
        `Resuming: ${state.progress.completedPageIds.size}/${state.inventory.totalPages} pages completed, ${state.progress.failedPageIds.size} previous failures`,
      );
      // Clear prior failures so they are retried this run.
      state.progress.failedPageIds.clear();
    } else {
      logger.info("Initializing conversion");
      const inventory = await inventoryPhase(client, logger);
      state = newState(
        {
          confluenceUrl: opts.confluenceUrl,
          outputDir: opts.outputDir,
          parallelism: opts.parallelism,
        },
        inventory,
      );
      await saveState(state, statePath);
    }

    const result = await importPhase(client, state, opts.outputDir, logger, {
      saveState: () => saveState(state, statePath),
    });

    await finalizePhase(state, opts.outputDir, result, logger, {
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    });

    if (result.pagesFailed > 0) {
      logger.warn(`Completed with ${result.pagesFailed} failures (partial success)`);
      return ExitCode.PartialSuccess;
    }
    logger.info("Conversion complete");
    return ExitCode.Success;
  } catch (err) {
    logger.error("Fatal error", { error: err as Error });
    return ExitCode.FatalError;
  } finally {
    await logger.close();
  }
}

function validateResume(state: ConversionState, opts: { confluenceUrl: string }, logger: Logger): void {
  if (state.config.confluenceUrl !== opts.confluenceUrl) {
    logger.warn("Confluence URL differs from the saved state; continuing with the saved inventory", {
      saved: state.config.confluenceUrl,
      provided: opts.confluenceUrl,
    });
  }
}

const exitCode = await main(process.argv.slice(2));
process.exit(exitCode);
