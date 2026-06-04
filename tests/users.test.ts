import { test, expect, describe } from "bun:test";
import type { ConfluenceUser } from "../src/types.ts";
import { toGitAuthor, UserMap } from "../src/users.ts";

function makeUser(overrides: Partial<ConfluenceUser> = {}): ConfluenceUser {
  return {
    type: "known",
    accountId: "acc-1",
    publicName: "Public Name",
    displayName: "Display Name",
    active: true,
    ...overrides,
  };
}

describe("toGitAuthor", () => {
  test("maps a user with an email to name=displayName, email=that email", () => {
    const user = makeUser({
      displayName: "Jane Doe",
      email: "jane@example.com",
    });
    expect(toGitAuthor(user)).toEqual({
      name: "Jane Doe",
      email: "jane@example.com",
    });
  });

  test("generates fallback email when email missing", () => {
    const user = makeUser({ accountId: "abc123", email: undefined });
    expect(toGitAuthor(user).email).toBe("abc123@confluence.local");
  });

  test("generates fallback email when email is empty string", () => {
    const user = makeUser({ accountId: "abc123", email: "" });
    expect(toGitAuthor(user).email).toBe("abc123@confluence.local");
  });

  test("falls back to publicName when displayName missing", () => {
    const user = makeUser({ displayName: "", publicName: "PubName" });
    expect(toGitAuthor(user).name).toBe("PubName");
  });

  test("falls back to accountId when displayName and publicName missing", () => {
    const user = makeUser({
      displayName: "",
      publicName: "",
      accountId: "acc-xyz",
    });
    expect(toGitAuthor(user).name).toBe("acc-xyz");
  });

  test("undefined user yields generic Unknown author", () => {
    expect(toGitAuthor(undefined)).toEqual({
      name: "Unknown",
      email: "unknown@confluence.local",
    });
  });

  test("null user yields generic Unknown author", () => {
    expect(toGitAuthor(null)).toEqual({
      name: "Unknown",
      email: "unknown@confluence.local",
    });
  });
});

describe("UserMap", () => {
  test("record + toGitAuthorById returns the recorded user's author", () => {
    const map = new UserMap();
    const user = makeUser({
      accountId: "u-1",
      displayName: "Recorded User",
      email: "rec@example.com",
    });
    map.record(user);
    expect(map.toGitAuthorById("u-1")).toEqual({
      name: "Recorded User",
      email: "rec@example.com",
    });
  });

  test("size reflects distinct recorded users; last write wins", () => {
    const map = new UserMap();
    map.record(makeUser({ accountId: "u-1", displayName: "First" }));
    map.record(makeUser({ accountId: "u-2", displayName: "Second" }));
    expect(map.size).toBe(2);

    map.record(makeUser({ accountId: "u-1", displayName: "Updated" }));
    expect(map.size).toBe(2);
    expect(map.toGitAuthorById("u-1").name).toBe("Updated");
  });

  test("get returns the raw recorded user", () => {
    const map = new UserMap();
    const user = makeUser({ accountId: "u-9" });
    map.record(user);
    expect(map.get("u-9")).toBe(user);
  });

  test("get returns undefined for unknown accountId", () => {
    const map = new UserMap();
    expect(map.get("missing")).toBeUndefined();
  });

  test("toGitAuthorById synthesizes fallback for unknown accountId (no fallbackDisplayName)", () => {
    const map = new UserMap();
    expect(map.toGitAuthorById("ghost")).toEqual({
      name: "ghost",
      email: "ghost@confluence.local",
    });
  });

  test("toGitAuthorById synthesizes fallback for unknown accountId (with fallbackDisplayName)", () => {
    const map = new UserMap();
    expect(map.toGitAuthorById("ghost", "Ghost Writer")).toEqual({
      name: "Ghost Writer",
      email: "ghost@confluence.local",
    });
  });
});
