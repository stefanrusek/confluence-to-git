import { describe, test, expect } from "bun:test";
import { parseArgs, CliError } from "../src/cli.ts";

describe("CLI argument parsing", () => {
  const base = [
    "--confluence-url",
    "https://x.atlassian.net/",
    "--api-token",
    "email@x.com:tok",
    "--output-dir",
    "./out",
  ];

  test("parses required args and strips trailing slash from url", () => {
    const { options } = parseArgs(base, {});
    expect(options).toBeDefined();
    expect(options!.confluenceUrl).toBe("https://x.atlassian.net");
    expect(options!.apiToken).toBe("email@x.com:tok");
    expect(options!.outputDir).toBe("./out");
    expect(options!.parallelism).toBe(4);
    expect(options!.verbose).toBe(false);
  });

  test("supports --key=value form", () => {
    const { options } = parseArgs([...base, "--parallelism=8"], {});
    expect(options!.parallelism).toBe(8);
  });

  test("--debug implies --verbose", () => {
    const { options } = parseArgs([...base, "--debug"], {});
    expect(options!.debug).toBe(true);
    expect(options!.verbose).toBe(true);
  });

  test("falls back to environment variables", () => {
    const { options } = parseArgs(["--output-dir", "./out"], {
      CONFLUENCE_URL: "https://env.atlassian.net",
      CONFLUENCE_API_TOKEN: "envtok",
    });
    expect(options!.confluenceUrl).toBe("https://env.atlassian.net");
    expect(options!.apiToken).toBe("envtok");
  });

  test("rejects out-of-range parallelism", () => {
    expect(() => parseArgs([...base, "--parallelism", "99"], {})).toThrow(CliError);
    expect(() => parseArgs([...base, "--parallelism", "0"], {})).toThrow(CliError);
  });

  test("errors when required args are missing", () => {
    expect(() => parseArgs(["--output-dir", "./out"], {})).toThrow(CliError);
  });

  test("returns help flag", () => {
    expect(parseArgs(["--help"], {}).help).toBe(true);
  });
});
