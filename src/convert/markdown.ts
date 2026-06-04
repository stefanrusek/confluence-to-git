/**
 * Confluence Storage format -> Markdown conversion.
 *
 * Strategy: the Storage format is XML-ish with `ac:`/`ri:` namespaced elements
 * and CDATA bodies that a plain HTML parser handles unreliably. So we first
 * PRE-PROCESS the Confluence-specific constructs (code macros, images,
 * internal links, unsupported macros) into clean standard HTML, then hand that
 * to `turndown` for the well-understood HTML subset. Unsupported macros are
 * emitted via text tokens because turndown strips HTML comments; the tokens are
 * substituted back into `<!-- Unsupported macro: ... -->` after conversion.
 */
import TurndownService from "turndown";
import { slugify } from "./slug.ts";

export interface ConversionContext {
  /** Slug of the page being converted; used to prefix attachment file names. */
  pageSlug?: string;
  /** Resolve an attachment file name to a repo-relative path from this page. */
  resolveAttachment?: (fileName: string) => string | undefined;
  /** Resolve an internal page link (by Confluence content title) to a relative path. */
  resolvePageLink?: (contentTitle: string) => string | undefined;
}

export interface ConversionResult {
  markdown: string;
  /** Human-readable notes about lossy/unsupported conversions. */
  warnings: string[];
}

const COMMENT_TOKEN_PREFIX = "C2GUNSUPPORTEDMACRO";

function buildTurndown(): TurndownService {
  const td = new TurndownService({
    codeBlockStyle: "fenced",
    headingStyle: "atx",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  // Best-effort GitHub-flavored table conversion (turndown has none built in).
  td.addRule("tables", {
    filter: "table",
    replacement: (_content, node) => {
      const el = node as unknown as {
        querySelectorAll: (s: string) => ArrayLike<{
          children: ArrayLike<{ innerHTML: string; textContent: string | null }>;
        }>;
      };
      const rows = Array.from(el.querySelectorAll("tr"));
      if (rows.length === 0) return "";

      const cellText = (cell: { innerHTML: string; textContent: string | null }): string => {
        // Preserve a little inline formatting, then strip remaining markup.
        const html = cell.innerHTML
          .replace(/<\s*(strong|b)\s*>/gi, "**")
          .replace(/<\s*\/\s*(strong|b)\s*>/gi, "**")
          .replace(/<\s*(em|i)\s*>/gi, "*")
          .replace(/<\s*\/\s*(em|i)\s*>/gi, "*")
          .replace(/<\s*code\s*>/gi, "`")
          .replace(/<\s*\/\s*code\s*>/gi, "`");
        const text = html
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&nbsp;/g, " ")
          .replace(/&quot;/g, '"')
          .replace(/\s+/g, " ")
          .replace(/\|/g, "\\|")
          .trim();
        return text;
      };

      const toRow = (cells: string[]): string => `| ${cells.join(" | ")} |`;
      const header = Array.from(rows[0]!.children).map(cellText);
      const lines = [toRow(header), toRow(header.map(() => "---"))];
      for (let i = 1; i < rows.length; i++) {
        lines.push(toRow(Array.from(rows[i]!.children).map(cellText)));
      }
      return `\n\n${lines.join("\n")}\n\n`;
    },
  });

  return td;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Decode the small set of XML entities Confluence uses in plain-text bodies. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractCdataOrText(body: string): string {
  const cdata = body.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) return cdata[1] ?? "";
  return decodeEntities(body.replace(/<[^>]+>/g, ""));
}

/**
 * Convert a Confluence Storage-format string to Markdown.
 */
export function convertStorageToMarkdown(
  storage: string,
  ctx: ConversionContext = {},
): ConversionResult {
  const warnings: string[] = [];
  const commentTokens: string[] = [];
  let html = storage;

  // 1. Code macros -> <pre><code class="language-..."> ... </code></pre>
  html = html.replace(
    /<ac:structured-macro[^>]*\bac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g,
    (_m, inner: string) => {
      const langMatch = inner.match(
        /<ac:parameter[^>]*\bac:name="language"[^>]*>([\s\S]*?)<\/ac:parameter>/,
      );
      const lang = langMatch ? decodeEntities(langMatch[1] ?? "").trim() : "";
      const bodyMatch = inner.match(/<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/);
      const code = bodyMatch ? extractCdataOrText(bodyMatch[1] ?? "") : "";
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      return `<pre><code${cls}>${escapeHtml(code)}</code></pre>`;
    },
  );

  // 2. Internal page links: <ac:link>...<ri:page ri:content-title="X"/>...</ac:link>
  html = html.replace(
    /<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g,
    (_m, inner: string) => {
      const titleMatch = inner.match(/<ri:page[^>]*\bri:content-title="([^"]*)"/);
      if (!titleMatch) return inner; // leave body, drop wrapper
      const title = decodeEntities(titleMatch[1] ?? "");
      const bodyMatch = inner.match(
        /<ac:(?:plain-text-link-body|link-body)>([\s\S]*?)<\/ac:(?:plain-text-link-body|link-body)>/,
      );
      const text = bodyMatch ? extractCdataOrText(bodyMatch[1] ?? "").trim() || title : title;
      const href = resolvePage(ctx, title, warnings);
      return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
    },
  );

  // 2b. Bare <a href="..."><ri:page ri:content-title="X"/></a> form.
  html = html.replace(
    /<a[^>]*>\s*<ri:page[^>]*\bri:content-title="([^"]*)"[^>]*\/?>\s*<\/a>/g,
    (_m, title: string) => {
      const t = decodeEntities(title);
      const href = resolvePage(ctx, t, warnings);
      return `<a href="${escapeHtml(href)}">${escapeHtml(t)}</a>`;
    },
  );

  // 3. Images: <ac:image ...><ri:attachment ri:filename="f"/></ac:image>
  html = html.replace(
    /<ac:image[^>]*>([\s\S]*?)<\/ac:image>/g,
    (_m, inner: string) => imageTag(inner, ctx, warnings),
  );
  // 3b. Self-closing <ac:image ac:src="/download/attachments/{id}/{file}"/>
  html = html.replace(
    /<ac:image\b([^>]*)\/>/g,
    (_m, attrs: string) => imageTag(attrs, ctx, warnings),
  );

  // 4. Remaining structured macros are unsupported -> comment token.
  html = html.replace(
    /<ac:structured-macro[^>]*\bac:name="([^"]*)"[^>]*>[\s\S]*?<\/ac:structured-macro>/g,
    (_m, name: string) => unsupported(name, commentTokens, warnings),
  );
  // Self-closing structured macros.
  html = html.replace(
    /<ac:structured-macro[^>]*\bac:name="([^"]*)"[^>]*\/>/g,
    (_m, name: string) => unsupported(name, commentTokens, warnings),
  );

  // 5. Convert to Markdown.
  const td = buildTurndown();
  let markdown = td.turndown(html);

  // 6. Restore unsupported-macro comments from their tokens.
  markdown = markdown.replace(
    new RegExp(`${COMMENT_TOKEN_PREFIX}(\\d+)`, "g"),
    (_m, idx: string) => commentTokens[Number(idx)] ?? "",
  );

  return { markdown: markdown.trim() + "\n", warnings };
}

function unsupported(name: string, tokens: string[], warnings: string[]): string {
  const idx = tokens.length;
  tokens.push(`<!-- Unsupported macro: ${name} -->`);
  warnings.push(`Unsupported macro: ${name}`);
  return `\n\n${COMMENT_TOKEN_PREFIX}${idx}\n\n`;
}

function resolvePage(ctx: ConversionContext, title: string, warnings: string[]): string {
  const resolved = ctx.resolvePageLink?.(title);
  if (resolved) return resolved;
  warnings.push(`Unresolved internal link to "${title}"`);
  return `${slugify(title)}.md`;
}

function imageTag(source: string, ctx: ConversionContext, warnings: string[]): string {
  let fileName: string | undefined;
  const attMatch = source.match(/<ri:attachment[^>]*\bri:filename="([^"]*)"/);
  if (attMatch) {
    fileName = attMatch[1];
  } else {
    const srcMatch = source.match(/\bac:src="([^"]*)"/);
    if (srcMatch?.[1]) fileName = srcMatch[1].split("/").pop();
  }
  if (!fileName) {
    warnings.push("Image with no resolvable filename");
    return "";
  }
  const decoded = decodeEntities(fileName);
  const rel =
    ctx.resolveAttachment?.(decoded) ??
    `attachments/${ctx.pageSlug ? ctx.pageSlug + "_" : ""}${decoded}`;
  return `<img src="${escapeHtml(rel)}" alt="${escapeHtml(decoded)}">`;
}
