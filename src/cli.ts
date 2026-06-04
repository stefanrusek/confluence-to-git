/**
 * CLI argument parsing and validation.
 */
import type { CliOptions } from "./types.ts";

export class CliError extends Error {}

const USAGE = `confluence-to-git — Convert a Confluence Cloud instance to a git repository

Usage:
  confluence-to-git --confluence-url <url> --api-token <token> --output-dir <path> [options]

Required:
  --confluence-url <url>   Confluence Cloud base URL (or $CONFLUENCE_URL)
  --api-token <token>      API token; use "email:token" for Cloud Basic auth
                           (or $CONFLUENCE_API_TOKEN)
  --output-dir <path>      Directory for the git repository

Options:
  --parallelism <n>        Concurrent page imports, 1-16 (default 4)
  --verbose                Enable INFO logging
  --debug                  Enable DEBUG logging (implies --verbose)
  -h, --help               Show this help
`;

export function helpText(): string {
  return USAGE;
}

interface RawArgs {
  values: Record<string, string | boolean | undefined>;
  help: boolean;
}

function parseRaw(argv: string[]): RawArgs {
  const values: Record<string, string | boolean | undefined> = {};
  let help = false;
  const booleanFlags = new Set(["verbose", "debug"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new CliError(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      values[key] = true;
      continue;
    }
    // Support --key=value and --key value.
    const eq = key.indexOf("=");
    if (eq >= 0) {
      values[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CliError(`Missing value for --${key}`);
    }
    values[key] = next;
    i++;
  }
  return { values, help };
}

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { options?: CliOptions; help?: boolean } {
  const { values, help } = parseRaw(argv);
  if (help) return { help: true };

  const confluenceUrl = (values["confluence-url"] as string) ?? env.CONFLUENCE_URL;
  const apiToken = (values["api-token"] as string) ?? env.CONFLUENCE_API_TOKEN;
  const outputDir = values["output-dir"] as string | undefined;

  if (!confluenceUrl) throw new CliError("Missing --confluence-url (or $CONFLUENCE_URL)");
  if (!apiToken) throw new CliError("Missing --api-token (or $CONFLUENCE_API_TOKEN)");
  if (!outputDir) throw new CliError("Missing --output-dir");

  let parallelism = 4;
  if (values.parallelism !== undefined) {
    parallelism = Number(values.parallelism);
    if (!Number.isInteger(parallelism) || parallelism < 1 || parallelism > 16) {
      throw new CliError("--parallelism must be an integer between 1 and 16");
    }
  }

  const debug = values.debug === true;
  const verbose = values.verbose === true || debug;

  return {
    options: {
      confluenceUrl: confluenceUrl.replace(/\/+$/, ""),
      apiToken,
      outputDir,
      parallelism,
      verbose,
      debug,
    },
  };
}
