/**
 * Structured logger that writes to both stdout and a log file in the output
 * directory (`.confluence-to-git.log`).
 *
 * Levels follow the spec:
 *   ERROR / WARN  -> always emitted
 *   INFO          -> requires --verbose
 *   DEBUG         -> requires --debug (implies verbose)
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger, LogLevel } from "./types.ts";

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LoggerOptions {
  verbose: boolean;
  debug: boolean;
  /** Directory where `.confluence-to-git.log` is written. */
  outputDir?: string;
}

/** Patterns that must never appear in logs (e.g. API tokens). */
function sanitize(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join("***REDACTED***");
    }
  }
  return out;
}

class FileConsoleLogger implements Logger {
  private readonly threshold: number;
  private readonly logFile?: string;
  private readonly secrets: string[];

  constructor(options: LoggerOptions, secrets: string[] = []) {
    const level: LogLevel = options.debug
      ? "debug"
      : options.verbose
        ? "info"
        : "warn";
    this.threshold = LEVEL_RANK[level];
    this.secrets = secrets;
    if (options.outputDir) {
      this.logFile = join(options.outputDir, ".confluence-to-git.log");
    }
  }

  private emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] > this.threshold) return;

    const timestamp = new Date().toISOString();
    let line = `[${level.toUpperCase()}] ${timestamp} | ${message}`;
    if (meta && Object.keys(meta).length > 0) {
      const metaStr = Object.entries(meta)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(" ");
      line += `\n  ${metaStr}`;
    }
    line = sanitize(line, this.secrets);

    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }

    if (this.logFile) {
      try {
        appendFileSync(this.logFile, line + "\n");
      } catch {
        // Never let logging failures crash the import.
      }
    }
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.emit("error", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.emit("warn", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.emit("info", message, meta);
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.emit("debug", message, meta);
  }

  async close(): Promise<void> {
    // appendFileSync is synchronous; nothing to flush.
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function createLogger(options: LoggerOptions, secrets: string[] = []): Logger {
  return new FileConsoleLogger(options, secrets);
}

/** A no-op logger useful for tests. */
export function createNullLogger(): Logger {
  return {
    error() {},
    warn() {},
    info() {},
    debug() {},
    async close() {},
  };
}
