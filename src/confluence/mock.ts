/**
 * In-memory mock of `ConfluenceClient` for integration tests. Lets tests build
 * up a synthetic Confluence instance (spaces, pages, versions, attachments,
 * comments) and optionally inject transient failures.
 */
import type {
  ConfluenceSpace,
  ConfluencePage,
  ConfluenceAttachment,
  ConfluenceComment,
  ConfluenceUser,
} from "../types.ts";
import type { ConfluenceClient, PageVersionContent } from "./client.ts";

function user(accountId: string, displayName = accountId, email?: string): ConfluenceUser {
  return {
    type: "known",
    accountId,
    publicName: displayName,
    displayName,
    active: true,
    ...(email ? { email } : {}),
  };
}

interface MockPageOptions {
  id: string;
  title: string;
  spaceKey: string;
  ancestors?: Array<{ id: string; title: string }>;
}

export class MockPage {
  readonly versions: PageVersionContent[] = [];
  readonly attachments: ConfluenceAttachment[] = [];
  readonly comments: ConfluenceComment[] = [];
  readonly attachmentBytes = new Map<string, Uint8Array>();

  constructor(
    readonly id: string,
    readonly title: string,
    readonly spaceKey: string,
    readonly ancestors: Array<{ id: string; title: string }>,
  ) {}

  addVersion(v: {
    number: number;
    title?: string;
    body: string;
    author: string;
    authorEmail?: string;
    timestamp: string;
    message?: string;
  }): this {
    this.versions.push({
      number: v.number,
      authorId: v.author,
      author: user(v.author, v.author, v.authorEmail),
      created: v.timestamp,
      message: v.message ?? "",
      title: v.title ?? this.title,
      storage: v.body,
    });
    return this;
  }

  addAttachment(a: { id: string; fileName: string; size?: number; bytes?: Uint8Array }): this {
    this.attachments.push({
      id: a.id,
      type: "attachment",
      title: a.fileName,
      fileName: a.fileName,
      mediaType: "application/octet-stream",
      fileSize: a.size ?? 0,
      createdDate: "2024-01-01T00:00:00Z",
      createdBy: user("uploader"),
      _links: { download: `/download/attachments/${this.id}/${a.fileName}`, webui: "" },
    });
    this.attachmentBytes.set(a.id, a.bytes ?? new Uint8Array([1, 2, 3]));
    return this;
  }

  addComment(c: { id: string; author: string; body: string; createdDate?: string }): this {
    this.comments.push({
      id: c.id,
      version: { number: 1 },
      type: "comment",
      body: { storage: { value: c.body } },
      createdBy: user(c.author),
      createdDate: c.createdDate ?? "2024-01-01T00:00:00Z",
      updatedDate: c.createdDate ?? "2024-01-01T00:00:00Z",
    });
    return this;
  }
}

export class MockConfluenceAPI implements ConfluenceClient {
  private readonly spaces: ConfluenceSpace[] = [];
  private readonly pages = new Map<string, MockPage>();
  /** Page IDs that should throw once before succeeding (simulated transient errors). */
  private readonly pendingErrors = new Set<string>();

  addSpace(s: { key: string; name: string; id?: string }): ConfluenceSpace {
    const space: ConfluenceSpace = {
      id: s.id ?? s.key,
      key: s.key,
      name: s.name,
      type: "global",
      status: "current",
      createdDate: "2024-01-01T00:00:00Z",
      _links: { webui: `/spaces/${s.key}` },
    };
    this.spaces.push(space);
    return space;
  }

  addPage(opts: MockPageOptions): MockPage {
    const page = new MockPage(opts.id, opts.title, opts.spaceKey, opts.ancestors ?? []);
    // Seed a default v1 so a page always has at least one version.
    page.addVersion({
      number: 1,
      title: opts.title,
      body: `<p>${opts.title}</p>`,
      author: "author1",
      timestamp: "2024-01-01T00:00:00Z",
    });
    this.pages.set(opts.id, page);
    return page;
  }

  /** Make the next history fetch for this page throw once (then recover). */
  failOnce(pageId: string): void {
    this.pendingErrors.add(pageId);
  }

  recoverError(pageId: string): void {
    this.pendingErrors.delete(pageId);
  }

  private space(key: string): ConfluenceSpace {
    return (
      this.spaces.find((s) => s.key === key) ?? {
        id: key,
        key,
        name: key,
        type: "global",
        status: "current",
        createdDate: "2024-01-01T00:00:00Z",
        _links: { webui: `/spaces/${key}` },
      }
    );
  }

  async getSpaces(): Promise<ConfluenceSpace[]> {
    return [...this.spaces];
  }

  async getPages(spaceKey: string): Promise<ConfluencePage[]> {
    const out: ConfluencePage[] = [];
    for (const p of this.pages.values()) {
      if (p.spaceKey !== spaceKey) continue;
      const latest = p.versions[p.versions.length - 1]!;
      out.push({
        id: p.id,
        type: "page",
        status: "current",
        title: p.title,
        space: this.space(p.spaceKey),
        version: {
          number: latest.number,
          minorEdit: false,
          authorId: latest.authorId,
          created: latest.created,
          message: latest.message,
        },
        createdBy: p.versions[0]!.author!,
        createdDate: p.versions[0]!.created,
        lastModifiedBy: latest.author!,
        lastModifiedDate: latest.created,
        ancestors: p.ancestors,
        body: { storage: { value: latest.storage, representation: "storage" } },
        _links: { webui: `/pages/${p.id}` },
      });
    }
    return out;
  }

  async getPageVersions(pageId: string): Promise<PageVersionContent[]> {
    if (this.pendingErrors.has(pageId)) {
      this.pendingErrors.delete(pageId);
      throw new Error(`Simulated API error fetching versions for ${pageId}`);
    }
    const page = this.pages.get(pageId);
    if (!page) throw new Error(`Unknown page ${pageId}`);
    return [...page.versions].sort((a, b) => a.number - b.number);
  }

  async getAttachments(pageId: string): Promise<ConfluenceAttachment[]> {
    return [...(this.pages.get(pageId)?.attachments ?? [])];
  }

  async downloadAttachment(att: ConfluenceAttachment): Promise<Uint8Array> {
    for (const p of this.pages.values()) {
      const bytes = p.attachmentBytes.get(att.id);
      if (bytes) return bytes;
    }
    return new Uint8Array();
  }

  async getComments(pageId: string): Promise<ConfluenceComment[]> {
    return [...(this.pages.get(pageId)?.comments ?? [])];
  }
}
