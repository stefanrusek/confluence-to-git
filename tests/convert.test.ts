import { describe, test, expect } from "bun:test";
import {
  slugify,
  buildPath,
  pagePath,
  attachmentName,
  resolveSlugCollision,
} from "../src/convert/slug.ts";
import {
  convertStorageToMarkdown,
  type ConversionContext,
} from "../src/convert/markdown.ts";

const convert = (input: string, ctx?: ConversionContext) =>
  convertStorageToMarkdown(input, ctx).markdown;

describe("slug / path logic", () => {
  test("slugifies page titles", () => {
    expect(slugify("API Reference & OAuth 2.0")).toBe("api-reference-oauth-2-0");
  });

  test("keeps underscores, lowercases, trims", () => {
    expect(slugify("  My_Page  ")).toBe("my_page");
  });

  test("falls back to 'untitled' for empty result", () => {
    expect(slugify("!!!")).toBe("untitled");
  });

  test("caps length at 200 chars", () => {
    expect(slugify("a".repeat(300)).length).toBe(200);
  });

  test("builds nested path from ancestors", () => {
    expect(buildPath(["Parent", "Child"], "Grandchild")).toBe(
      "parent/child/grandchild.md",
    );
  });

  test("pagePath prefixes the space key verbatim", () => {
    expect(pagePath("DEVDOCS", ["API Reference", "Authentication"], "OAuth 2.0")).toBe(
      "DEVDOCS/api-reference/authentication/oauth-2-0.md",
    );
  });

  test("attachment filename uses page prefix", () => {
    expect(attachmentName("api-guide", "diagram.png")).toBe("api-guide_diagram.png");
  });

  test("resolves filename collisions with pageId suffix", () => {
    const taken = new Set<string>();
    expect(resolveSlugCollision("test", "123", taken)).toBe("test");
    expect(resolveSlugCollision("test", "456", taken)).toBe("test-456");
  });
});

describe("Storage -> Markdown conversion", () => {
  test("converts bold text", () => {
    expect(convert("<strong>hello</strong>")).toBe("**hello**\n");
  });

  test("converts italic text", () => {
    expect(convert("<em>hi</em>")).toBe("*hi*\n");
  });

  test("converts inline code", () => {
    expect(convert("<code>x</code>")).toBe("`x`\n");
  });

  test("converts nested bold+italic", () => {
    expect(convert("<strong><em>bold and italic</em></strong>")).toContain(
      "***bold and italic***",
    );
  });

  test("converts code blocks with language (CDATA body)", () => {
    const input = `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body><![CDATA[def foo(): pass]]></ac:plain-text-body></ac:structured-macro>`;
    const out = convert(input);
    expect(out).toContain("```python");
    expect(out).toContain("def foo(): pass");
  });

  test("converts headings", () => {
    expect(convert("<h1>Title</h1>")).toContain("# Title");
    expect(convert("<h2>Sub</h2>")).toContain("## Sub");
  });

  test("converts unordered and ordered lists", () => {
    expect(convert("<ul><li>a</li><li>b</li></ul>")).toContain("-   a");
    expect(convert("<ol><li>one</li></ol>")).toContain("1.  one");
  });

  test("converts external links", () => {
    expect(convert('<a href="https://x.com">link</a>')).toContain("[link](https://x.com)");
  });

  test("converts Confluence tables to Markdown", () => {
    const input =
      "<table><tr><th>Col1</th><th>Col2</th></tr><tr><td>A</td><td>B</td></tr></table>";
    const out = convert(input);
    expect(out).toContain("| Col1 | Col2 |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| A | B |");
  });

  test("converts internal page links with relative paths", () => {
    const input = '<ac:link><ri:page ri:content-title="Target Page"/></ac:link>';
    const ctx: ConversionContext = {
      resolvePageLink: (title) =>
        title === "Target Page" ? "../space/target-page.md" : undefined,
    };
    expect(convert(input, ctx)).toContain("[Target Page](../space/target-page.md)");
  });

  test("converts bare anchor + ri:page internal links", () => {
    const input = '<a href="#"><ri:page ri:content-title="Other"/></a>';
    const ctx: ConversionContext = {
      resolvePageLink: (t) => (t === "Other" ? "other.md" : undefined),
    };
    expect(convert(input, ctx)).toContain("[Other](other.md)");
  });

  test("converts ac:image attachments to relative markdown image", () => {
    const input =
      '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>';
    const out = convert(input, { pageSlug: "api-guide" });
    expect(out).toContain("![diagram.png](attachments/api-guide_diagram.png)");
  });

  test("rewrites ac:src download images to flat attachment path", () => {
    const input = '<ac:image ac:src="/download/attachments/123/photo.jpg"/>';
    const out = convert(input, { pageSlug: "doc" });
    expect(out).toContain("attachments/doc_photo.jpg");
  });

  test("preserves unknown macros as HTML comments", () => {
    const input =
      '<ac:structured-macro ac:name="unknown"><ac:parameter>value</ac:parameter></ac:structured-macro>';
    expect(convert(input)).toContain("<!-- Unsupported macro: unknown -->");
  });

  test("reports warnings for unsupported macros", () => {
    const input = '<ac:structured-macro ac:name="jira">x</ac:structured-macro>';
    const result = convertStorageToMarkdown(input);
    expect(result.warnings.some((w) => w.includes("jira"))).toBe(true);
  });
});
