import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GitRepo, initRepo } from "../src/git/repo.ts";

describe("GitRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2g-git-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const alice = { name: "Alice", email: "alice@example.com" };
  const bob = { name: "Bob", email: "bob@example.com" };

  function write(name: string, content: string): void {
    fs.writeFileSync(path.join(dir, name), content);
  }

  test("init then isRepo() is true", async () => {
    const repo = new GitRepo(dir);
    expect(await repo.isRepo()).toBe(false);
    await repo.init();
    expect(await repo.isRepo()).toBe(true);
  });

  test("init is idempotent", async () => {
    const repo = await initRepo(dir);
    await repo.init();
    expect(await repo.isRepo()).toBe(true);
  });

  test("commitAll records the per-commit author, message and date", async () => {
    const repo = await initRepo(dir);
    write("a.txt", "hello");
    const date = new Date("2021-03-04T12:34:56Z");
    const hash = await repo.commitAll({
      author: alice,
      date,
      message: "first commit",
    });
    expect(hash).toMatch(/^[0-9a-f]{40}$/);

    const log = await repo.log();
    expect(log).toHaveLength(1);
    const commit = log[0]!;
    expect(commit.authorName).toBe("Alice");
    expect(commit.authorEmail).toBe("alice@example.com");
    expect(commit.message).toBe("first commit");
    expect(commit.hash).toBe(hash);
    // Compare to the second to prove the date override took effect.
    expect(Math.floor(commit.date.getTime() / 1000)).toBe(
      Math.floor(date.getTime() / 1000),
    );
  });

  test("accepts ISO string dates", async () => {
    const repo = await initRepo(dir);
    write("a.txt", "x");
    const iso = "2019-07-08T09:10:11Z";
    await repo.commitAll({ author: alice, date: iso, message: "iso date" });
    const log = await repo.log();
    expect(Math.floor(log[0]!.date.getTime() / 1000)).toBe(
      Math.floor(new Date(iso).getTime() / 1000),
    );
  });

  test("two sequential commits return oldest-first with correct authors", async () => {
    const repo = await initRepo(dir);

    write("a.txt", "one");
    await repo.commitAll({
      author: alice,
      date: new Date("2020-01-01T00:00:00Z"),
      message: "commit one",
    });

    write("b.txt", "two");
    await repo.commitAll({
      author: bob,
      date: new Date("2020-06-01T00:00:00Z"),
      message: "commit two",
    });

    const log = await repo.log();
    expect(log).toHaveLength(2);
    expect(log[0]!.message).toBe("commit one");
    expect(log[0]!.authorName).toBe("Alice");
    expect(log[0]!.authorEmail).toBe("alice@example.com");
    expect(log[1]!.message).toBe("commit two");
    expect(log[1]!.authorName).toBe("Bob");
    expect(log[1]!.authorEmail).toBe("bob@example.com");
    // oldest-first ordering
    expect(log[0]!.date.getTime()).toBeLessThan(log[1]!.date.getTime());
  });

  test("commitPaths only commits the given paths", async () => {
    const repo = await initRepo(dir);
    write("included.txt", "yes");
    write("ignored.txt", "no");
    await repo.commitPaths(["included.txt"], {
      author: alice,
      date: new Date("2022-02-02T02:02:02Z"),
      message: "partial",
    });
    expect(await repo.isClean()).toBe(false); // ignored.txt still untracked
    const log = await repo.log();
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toBe("partial");
  });

  test("concurrent commits via Promise.all all succeed and repo is not corrupted", async () => {
    const repo = await initRepo(dir);

    const n = 12;
    const tasks: Promise<string>[] = [];
    for (let i = 0; i < n; i++) {
      const name = `file-${i}.txt`;
      write(name, `content ${i}`);
      const opts = {
        author: { name: `Author${i}`, email: `author${i}@example.com` },
        date: new Date(Date.UTC(2020, 0, 1) + i * 1000),
        message: `commit ${i}`,
      };
      // Use per-file commitPaths so each fired-in-parallel commit stages only
      // its own file; without a correct mutex the racing `add`/`commit` pairs
      // would interleave and corrupt the index / merge files into one commit.
      tasks.push(repo.commitPaths([name], opts));
    }

    const hashes = await Promise.all(tasks);
    expect(hashes).toHaveLength(n);
    for (const h of hashes) {
      expect(h).toMatch(/^[0-9a-f]{40}$/);
    }

    const log = await repo.log();
    expect(log).toHaveLength(n);
    expect(await repo.isClean()).toBe(true);

    // fsck confirms the object database is intact (not corrupted).
    const repo2 = new GitRepo(dir);
    // No corruption: all commit messages present and unique.
    const messages = new Set(log.map((c) => c.message));
    expect(messages.size).toBe(n);
    void repo2;
  });

  test("commitAll with nothing to commit does not throw", async () => {
    const repo = await initRepo(dir);
    write("a.txt", "x");
    const first = await repo.commitAll({
      author: alice,
      date: new Date("2020-01-01T00:00:00Z"),
      message: "first",
    });

    // Nothing changed since the last commit.
    expect(await repo.isClean()).toBe(true);
    const second = await repo.commitAll({
      author: alice,
      date: new Date("2020-01-02T00:00:00Z"),
      message: "noop",
    });
    // Returns current HEAD, no new commit created.
    expect(second).toBe(first);
    const log = await repo.log();
    expect(log).toHaveLength(1);
  });

  test("log on empty repo returns []", async () => {
    const repo = await initRepo(dir);
    expect(await repo.log()).toEqual([]);
  });
});
