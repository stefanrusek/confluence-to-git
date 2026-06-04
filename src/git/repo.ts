/**
 * Thin wrapper around the `git` CLI for reconstructing Confluence version
 * history as commits.
 *
 * All git invocations use {@link execFile} with explicit argument arrays (never
 * a shell string) so that page titles, author names, and commit messages cannot
 * trigger shell injection. Mutating operations (init/commit) are serialized
 * through a small async mutex so that concurrent page imports cannot corrupt
 * the index.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitAuthor, Logger } from "../types.ts";

const execFileAsync = promisify(execFile);

/** ASCII unit separator — used as a field delimiter in the git log format. */
const US = "\x1f";

export interface CommitOptions {
  author: GitAuthor;
  /** Commit timestamp (Date or ISO string). Used for author & committer date. */
  date: Date | string;
  message: string;
}

export interface CommitInfo {
  hash: string;
  authorName: string;
  authorEmail: string;
  date: Date;
  message: string;
}

function toIso(date: Date | string): string {
  return typeof date === "string" ? new Date(date).toISOString() : date.toISOString();
}

export class GitRepo {
  readonly dir: string;
  private readonly logger?: Logger;

  /**
   * Promise-chain mutex. Each mutating operation appends itself to this chain,
   * guaranteeing they run one-at-a-time even when callers fire them in
   * parallel (e.g. via `Promise.all`).
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(dir: string, logger?: Logger) {
    this.dir = dir;
    this.logger = logger;
  }

  /** Run `git` with the given args (no shell) inside `this.dir`. */
  private async git(
    args: string[],
    env?: NodeJS.ProcessEnv,
  ): Promise<{ stdout: string; stderr: string }> {
    this.logger?.debug("git", { args, cwd: this.dir });
    const result = await execFileAsync("git", args, {
      cwd: this.dir,
      env: env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  /**
   * Serialize a mutating operation through the mutex. The chain is advanced
   * regardless of success/failure so a single failure does not deadlock later
   * operations.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    // Keep the chain alive even if `run` rejects; swallow here so the chain's
    // own settle does not produce an unhandled rejection.
    this.lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** True if `dir` already contains a git repository. */
  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await this.git(["rev-parse", "--is-inside-work-tree"]);
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  /** `git init` (idempotent) and ensure a default branch exists. */
  async init(): Promise<void> {
    await this.runExclusive(async () => {
      if (await this.isRepo()) {
        return;
      }
      // `-b main` ensures a deterministic default branch independent of the
      // user's global `init.defaultBranch` setting.
      await this.git(["init", "-b", "main"]);
      this.logger?.info("Initialized git repository", { dir: this.dir });
    });
  }

  /**
   * Build the git arguments + environment that pin both author and committer
   * identity and date, so reconstructed history is faithful regardless of the
   * machine's global git config.
   */
  private buildCommitArgs(options: CommitOptions): {
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    const { author, date, message } = options;
    const iso = toIso(date);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: iso,
    };
    const args = [
      // `-c user.*` lets commits succeed even without any global git identity.
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      // Reconstructed history should never be GPG/SSH-signed; disabling here
      // also avoids relying on the host's global `commit.gpgsign` setting.
      "-c",
      "commit.gpgsign=false",
      "commit",
      `--author=${author.name} <${author.email}>`,
      "-m",
      message,
    ];
    return { args, env };
  }

  /**
   * Stage everything (`git add -A`) and commit. Serialized via the mutex.
   *
   * "Nothing to commit" behavior: if the working tree is clean, this does NOT
   * throw and does NOT create an empty commit; it returns the current HEAD
   * hash instead (or an empty string if the repo has no commits yet).
   */
  async commitAll(options: CommitOptions): Promise<string> {
    return this.runExclusive(() => this.doCommit(null, options));
  }

  /**
   * Stage specific paths (relative to `dir`) and commit. Serialized via the
   * mutex. Same "nothing to commit" behavior as {@link commitAll}.
   */
  async commitPaths(paths: string[], options: CommitOptions): Promise<string> {
    return this.runExclusive(() => this.doCommit(paths, options));
  }

  /** Internal commit worker; must only be invoked inside the mutex. */
  private async doCommit(
    paths: string[] | null,
    options: CommitOptions,
  ): Promise<string> {
    if (paths === null) {
      await this.git(["add", "-A"]);
    } else if (paths.length > 0) {
      await this.git(["add", "--", ...paths]);
    }

    if (await this.isClean()) {
      this.logger?.debug("Nothing to commit; returning current HEAD", {
        dir: this.dir,
      });
      return this.headHash();
    }

    const { args, env } = this.buildCommitArgs(options);
    await this.git(args, env);
    const hash = await this.headHash();
    this.logger?.debug("Created commit", { hash, message: options.message });
    return hash;
  }

  /** Return the current HEAD hash, or "" if the repo has no commits. */
  private async headHash(): Promise<string> {
    try {
      const { stdout } = await this.git(["rev-parse", "HEAD"]);
      return stdout.trim();
    } catch {
      return "";
    }
  }

  /** Return commits oldest-first. Empty repo -> []. */
  async log(): Promise<CommitInfo[]> {
    let stdout: string;
    try {
      const result = await this.git([
        "log",
        "--reverse",
        `--pretty=format:%H${US}%an${US}%ae${US}%aI${US}%s`,
      ]);
      stdout = result.stdout;
    } catch {
      // No commits yet (`git log` exits non-zero on an unborn branch).
      return [];
    }

    const trimmed = stdout.replace(/\n+$/, "");
    if (trimmed.length === 0) {
      return [];
    }

    return trimmed.split("\n").map((line) => {
      const [hash = "", authorName = "", authorEmail = "", isoDate = "", message = ""] =
        line.split(US);
      return {
        hash,
        authorName,
        authorEmail,
        date: new Date(isoDate),
        message,
      };
    });
  }

  /** True if there is nothing staged/unstaged to commit. */
  async isClean(): Promise<boolean> {
    const { stdout } = await this.git(["status", "--porcelain"]);
    return stdout.trim().length === 0;
  }
}

/** Convenience: init a repo and return the wrapper. */
export async function initRepo(dir: string, logger?: Logger): Promise<GitRepo> {
  const repo = new GitRepo(dir, logger);
  await repo.init();
  return repo;
}
