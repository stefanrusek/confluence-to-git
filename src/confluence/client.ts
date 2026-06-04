/**
 * Confluence Cloud REST API client.
 *
 * Exposes a `ConfluenceClient` interface so the import/inventory phases can run
 * against either the real HTTP client or a mock (see `mock.ts`). The HTTP
 * implementation paginates, retries on rate-limit/5xx with exponential backoff,
 * and never logs the API token.
 */
import type {
  ConfluenceSpace,
  ConfluencePage,
  ConfluenceAttachment,
  ConfluenceComment,
  ConfluenceUser,
  Logger,
} from "../types.ts";

/** A single historical version of a page, including its rendered storage body. */
export interface PageVersionContent {
  number: number;
  authorId: string;
  author?: ConfluenceUser;
  created: string;
  message: string;
  title: string;
  storage: string;
}

export interface ConfluenceClient {
  /** All spaces (global + personal) the token can see. */
  getSpaces(): Promise<ConfluenceSpace[]>;
  /** All current pages in a space, with body/version/ancestors expanded. */
  getPages(spaceKey: string): Promise<ConfluencePage[]>;
  /** All versions of a page, oldest-first, each with its storage body. */
  getPageVersions(pageId: string): Promise<PageVersionContent[]>;
  /** Attachments belonging to a page. */
  getAttachments(pageId: string): Promise<ConfluenceAttachment[]>;
  /** Download an attachment's bytes. */
  downloadAttachment(att: ConfluenceAttachment): Promise<Uint8Array>;
  /** Footer + inline comments on a page. */
  getComments(pageId: string): Promise<ConfluenceComment[]>;
}

export interface HttpClientOptions {
  baseUrl: string;
  apiToken: string;
  logger: Logger;
  /** Max attempts for retryable failures (default 3). */
  maxRetries?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for transient HTTP statuses worth retrying. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || (status >= 500 && status <= 599);
}

export class ConfluenceApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ConfluenceApiError";
  }
}

export class HttpConfluenceClient implements ConfluenceClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly logger: Logger;
  private readonly maxRetries: number;

  constructor(options: HttpClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.maxRetries = options.maxRetries ?? 3;
    this.authHeader = buildAuthHeader(options.apiToken);
  }

  // --- low-level request helpers ------------------------------------------

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.base}${path}`;
    let attempt = 0;
    // attempt 1, then retries: waits 1s, 3s, 7s... (2^n - 1) seconds
    for (;;) {
      attempt++;
      try {
        const res = await fetch(url, {
          ...init,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(init?.headers ?? {}),
          },
        });
        if (res.ok) return res;

        if (isRetryableStatus(res.status) && attempt <= this.maxRetries) {
          const wait = this.backoffMs(attempt, res.headers.get("Retry-After"));
          this.logger.warn(`HTTP ${res.status}, retrying`, {
            attempt: `${attempt}/${this.maxRetries}`,
            waitMs: wait,
          });
          await sleep(wait);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new ConfluenceApiError(
            "Authentication failed (check API token / permissions)",
            res.status,
          );
        }
        throw new ConfluenceApiError(`Request failed: ${res.status} ${res.statusText}`, res.status);
      } catch (err) {
        if (err instanceof ConfluenceApiError) throw err;
        // Network error: retry.
        if (attempt <= this.maxRetries) {
          const wait = this.backoffMs(attempt, null);
          this.logger.warn("Network error, retrying", {
            attempt: `${attempt}/${this.maxRetries}`,
            waitMs: wait,
            error: (err as Error).message,
          });
          await sleep(wait);
          continue;
        }
        throw new ConfluenceApiError(`Network error: ${(err as Error).message}`);
      }
    }
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (!Number.isNaN(secs)) return secs * 1000;
    }
    return (Math.pow(2, attempt) - 1) * 1000;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  /** Walk a paginated v1 collection following `_links.next`. */
  private async getPaginated<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const chunk: { results: T[]; _links?: { next?: string } } = await this.getJson(next);
      results.push(...chunk.results);
      next = chunk._links?.next ? `${this.base}/wiki${chunk._links.next}` : undefined;
    }
    return results;
  }

  // --- ConfluenceClient ----------------------------------------------------

  getSpaces(): Promise<ConfluenceSpace[]> {
    return this.getPaginated<ConfluenceSpace>("/wiki/rest/api/space?limit=100&expand=description");
  }

  getPages(spaceKey: string): Promise<ConfluencePage[]> {
    const expand = "body.storage,version,ancestors,space,history,history.createdBy";
    return this.getPaginated<ConfluencePage>(
      `/wiki/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&status=current&limit=50&expand=${encodeURIComponent(expand)}`,
    );
  }

  async getPageVersions(pageId: string): Promise<PageVersionContent[]> {
    const versions = await this.getPaginated<{
      number: number;
      message?: string;
      when?: string;
      by?: ConfluenceUser;
    }>(`/wiki/rest/api/content/${pageId}/version?limit=50&expand=content`);

    const sorted = versions.sort((a, b) => a.number - b.number);
    const out: PageVersionContent[] = [];
    for (const v of sorted) {
      // Fetch the historical body for this version number.
      const detail = await this.getJson<{
        title: string;
        body?: { storage?: { value?: string } };
      }>(
        `/wiki/rest/api/content/${pageId}?status=historical&version=${v.number}&expand=body.storage`,
      ).catch(() => undefined);
      out.push({
        number: v.number,
        authorId: v.by?.accountId ?? "unknown",
        author: v.by,
        created: v.when ?? new Date().toISOString(),
        message: v.message ?? "",
        title: detail?.title ?? "",
        storage: detail?.body?.storage?.value ?? "",
      });
    }
    return out;
  }

  getAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    return this.getPaginated<ConfluenceAttachment>(
      `/wiki/rest/api/content/${pageId}/child/attachment?limit=50&expand=version`,
    );
  }

  async downloadAttachment(att: ConfluenceAttachment): Promise<Uint8Array> {
    const download = att._links.download;
    const url = download.startsWith("http") ? download : `${this.base}/wiki${download}`;
    const res = await this.request(url, { headers: { Accept: "*/*" } });
    return new Uint8Array(await res.arrayBuffer());
  }

  getComments(pageId: string): Promise<ConfluenceComment[]> {
    return this.getPaginated<ConfluenceComment>(
      `/wiki/rest/api/content/${pageId}/child/comment?limit=50&expand=body.storage,version,history,history.createdBy`,
    );
  }
}

/**
 * Build an Authorization header. Confluence Cloud uses Basic auth with
 * `email:token`; Server/DC personal access tokens use Bearer. If the token
 * contains a colon we treat it as `email:token` (Basic), otherwise Bearer.
 */
export function buildAuthHeader(apiToken: string): string {
  if (apiToken.includes(":")) {
    return `Basic ${Buffer.from(apiToken).toString("base64")}`;
  }
  return `Bearer ${apiToken}`;
}
