# confluence-to-git

Convert an entire **Confluence Cloud** instance into a local **git repository**,
preserving page content, version history, comments, and attachments.

- **Content** → Markdown (`.md`), one file per page
- **History** → one git commit per Confluence page version (original author, date, message)
- **Comments** → `*.comments.json` sidecar files
- **Attachments** → `attachments/` directories next to each page
- **Resumable** → progress is tracked in a state file; re-run to retry failures
- **Parallel** → pages import concurrently (each page is an atomic unit)

Built with **TypeScript** on the **Bun** runtime; ships as a standalone executable.

## Install / build

```bash
bun install
bun run build        # produces ./dist/confluence-to-git
```

Or run straight from source:

```bash
bun run src/index.ts --help
```

## Usage

```bash
confluence-to-git \
  --confluence-url https://yourcompany.atlassian.net \
  --api-token "you@company.com:<api-token>" \
  --output-dir ./my-confluence-repo \
  --parallelism 6 \
  --verbose
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--confluence-url` | yes | — | Confluence Cloud base URL (or `$CONFLUENCE_URL`) |
| `--api-token` | yes | — | API token. Use `email:token` for Cloud Basic auth (or `$CONFLUENCE_API_TOKEN`) |
| `--output-dir` | yes | — | Directory to create/populate the git repo |
| `--parallelism` | no | `4` | Concurrent page imports (1–16) |
| `--verbose` | no | `false` | INFO-level logging |
| `--debug` | no | `false` | DEBUG-level logging (implies `--verbose`) |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Full success — all pages imported |
| `1` | Partial success — some pages failed (see `MIGRATION_REPORT.md`) |
| `2` | Resumable failure — state preserved, re-run to continue |
| `3` | Fatal error — invalid credentials, output dir inaccessible, etc. |

### Resuming

If a run is interrupted, the state file `.confluence-import-state.json` remains in
the output directory. Re-run the **same command** to resume: completed pages are
skipped and previously-failed pages are retried.

## Architecture

Three-phase model — see the [specification](#) for full detail:

```
Phase 1: Inventory  →  Phase 2: Import (parallel)  →  Phase 3: Finalize
  spaces/pages/         per-page atomic import:        README.md
  attachments           history → commits             MIGRATION_REPORT.md
  → state file          markdown + attachments         final commit
                        + comment sidecars             delete state file
```

Source layout:

| Path | Responsibility |
|------|----------------|
| `src/types.ts` | Shared data models (Confluence entities, state, git mapping) |
| `src/cli.ts` | Argument parsing/validation |
| `src/index.ts` | Orchestration: fresh/resume detection, phase sequencing, exit codes |
| `src/logger.ts` | Leveled logging to stdout + `.confluence-to-git.log` (token-redacting) |
| `src/confluence/client.ts` | Confluence REST client (`ConfluenceClient` interface + HTTP impl, retry/backoff) |
| `src/confluence/mock.ts` | In-memory mock client for tests |
| `src/convert/slug.ts` | Slug / repo-path / attachment-name helpers |
| `src/convert/markdown.ts` | Confluence Storage → Markdown (code, tables, images, links, macros) |
| `src/state.ts` | Atomic, resumable state file |
| `src/users.ts` | Confluence user → git author mapping |
| `src/git/repo.ts` | git CLI wrapper with per-commit author/date and a write mutex |
| `src/phases/*` | `inventory`, `import`, `finalize`, plus the internal-link `pageIndex` |

## Testing

```bash
bun test          # unit + integration tests (mock Confluence, real git)
bun run typecheck # tsc --noEmit
```

## Known limitations

- Markdown conversion is best-effort; unsupported macros are preserved as
  `<!-- Unsupported macro: name -->` comments.
- Cloud authentication uses Basic auth (`email:token`); a colon-free token is
  sent as a Bearer token (Server/DC PATs).
- Attachments and comments are committed in a single trailing commit per page
  rather than attributed to the exact version that introduced them.
