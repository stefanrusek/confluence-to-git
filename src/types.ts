/**
 * Shared data models and cross-module contracts for confluence-to-git.
 *
 * These types are the stable interface that every module depends on. They
 * mirror the Confluence Cloud REST API entities plus the internal state and
 * git-mapping models described in the specification.
 */

// ---------------------------------------------------------------------------
// Confluence entities
// ---------------------------------------------------------------------------

export interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type: "global" | "personal";
  status: "current" | "archived";
  createdDate: string;
  _links: {
    webui: string;
  };
}

export interface ConfluenceUser {
  type: "known" | "unknown";
  username?: string;
  accountId: string;
  email?: string;
  publicName: string;
  displayName: string;
  active: boolean;
}

export interface ConfluencePageVersion {
  number: number;
  minorEdit: boolean;
  authorId: string;
  created: string;
  message: string;
}

export interface ConfluencePage {
  id: string;
  type: "page" | "blogpost";
  status: "current" | "archived" | "trashed";
  title: string;
  space: ConfluenceSpace;
  version: ConfluencePageVersion;
  createdBy: ConfluenceUser;
  createdDate: string;
  lastModifiedBy: ConfluenceUser;
  lastModifiedDate: string;
  ancestors: Array<{ id: string; title: string }>;
  body: {
    storage: { value: string; representation: string };
  };
  children?: {
    page?: Array<{ results: ConfluencePage[] }>;
    attachment?: Array<{ results: ConfluenceAttachment[] }>;
  };
  attachments?: {
    results: ConfluenceAttachment[];
  };
  _links: {
    webui: string;
  };
}

export interface ConfluenceAttachment {
  id: string;
  type: string;
  title: string;
  fileName: string;
  mediaType: string;
  fileSize: number;
  createdDate: string;
  createdBy: ConfluenceUser;
  _links: {
    download: string;
    webui: string;
  };
}

export interface ConfluenceComment {
  id: string;
  version: {
    number: number;
  };
  type: "comment";
  body: {
    storage: { value: string };
  };
  createdBy: ConfluenceUser;
  createdDate: string;
  updatedDate: string;
  restrictions?: {
    update?: Array<{ type: string; user: ConfluenceUser }>;
  };
}

// ---------------------------------------------------------------------------
// Internal state models
// ---------------------------------------------------------------------------

export interface InventoryPageEntry {
  page: ConfluencePage;
  spaceKey: string;
  attachmentCount: number;
  versionCount: number;
}

export interface ConversionInventory {
  spaces: ConfluenceSpace[];
  pages: InventoryPageEntry[];
  totalPages: number;
  totalAttachments: number;
  createdAt: string;
}

export interface ConversionConfig {
  confluenceUrl: string;
  outputDir: string;
  parallelism: number;
}

export interface ConversionProgress {
  /** Page IDs that were fully imported. */
  completedPageIds: Set<string>;
  /** Page ID -> last failure reason. */
  failedPageIds: Map<string, string>;
  startedAt: string;
  lastUpdated: string;
}

export interface ConversionState {
  /** Schema version of the state file. */
  version: string;
  inventory: ConversionInventory;
  progress: ConversionProgress;
  config: ConversionConfig;
}

// ---------------------------------------------------------------------------
// Git mapping
// ---------------------------------------------------------------------------

export interface GitAuthor {
  name: string;
  email: string;
}

export interface GitCommitMetadata {
  pageId: string;
  versionNumber: number;
  authorName: string;
  authorEmail: string;
  timestamp: string;
  message: string;
}

// ---------------------------------------------------------------------------
// CLI / runtime
// ---------------------------------------------------------------------------

export interface CliOptions {
  confluenceUrl: string;
  apiToken: string;
  outputDir: string;
  parallelism: number;
  verbose: boolean;
  debug: boolean;
}

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Logger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  /** Flush and close any underlying file handles. */
  close(): Promise<void>;
}

/** Process exit codes defined by the specification. */
export enum ExitCode {
  Success = 0,
  PartialSuccess = 1,
  ResumableFailure = 2,
  FatalError = 3,
}
