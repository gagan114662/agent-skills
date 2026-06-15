/**
 * A minimal, pure markdown → typed-blocks renderer for the prerendered blog (#252). It is a faithful
 * copy of the server's marketing-site renderer (`apps/server/src/site/markdown.ts`, #153), kept separate
 * so the blog can render the same typed blocks in the browser and in the Vite SSR prerender without
 * depending on the API process. It deliberately does NOT emit HTML: it returns the `SiteBlock`
 * discriminated union (heading/paragraph/list/quote/code/table) with inline runs (text/strong/link), so
 * the existing `Markdown` component maps blocks to elements with no `dangerouslySetInnerHTML` anywhere —
 * agent-authored blog content can never inject markup. Pure and total.
 */
import type { SiteBlock, SiteInline } from "../api/types.js";

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/;
const STRONG = /\*\*([^*]+)\*\*/;

/** Split a markdown table row (`| a | b |`) into trimmed cell strings. */
function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Parse inline `**bold**` and `[text](url)` runs, leaving everything else as plain text. */
export function parseInline(text: string): SiteInline[] {
  const out: SiteInline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const link = LINK.exec(rest);
    const strong = STRONG.exec(rest);
    // Whichever special run appears first wins; ties broken by link (rare).
    const next =
      link && strong ? (link.index <= strong.index ? "link" : "strong") : link ? "link" : strong ? "strong" : null;
    if (next === null) {
      out.push({ type: "text", text: rest });
      break;
    }
    const match = next === "link" ? link! : strong!;
    if (match.index > 0) out.push({ type: "text", text: rest.slice(0, match.index) });
    if (next === "link") {
      out.push({ type: "link", text: link![1] ?? "", href: link![2] ?? "" });
    } else {
      out.push({ type: "strong", text: strong![1] ?? "" });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out.length > 0 ? out : [{ type: "text", text: "" }];
}

/** Render a markdown string into an ordered list of typed blocks. */
export function renderMarkdown(md: string): SiteBlock[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: SiteBlock[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]): void => {
    if (buf.length > 0) blocks.push({ type: "paragraph", inline: parseInline(buf.join(" ")) });
  };

  let paragraph: string[] = [];

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Fenced code block.
    if (trimmed.startsWith("```")) {
      flushParagraph(paragraph);
      paragraph = [];
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++; // skip the closing fence
      blocks.push({ type: "code", text: code.join("\n") });
      continue;
    }

    // Blank line ends a paragraph.
    if (trimmed === "") {
      flushParagraph(paragraph);
      paragraph = [];
      i++;
      continue;
    }

    // Heading.
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph(paragraph);
      paragraph = [];
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length as 1 | 2 | 3,
        inline: parseInline(heading[2] ?? ""),
      });
      i++;
      continue;
    }

    // Blockquote (consecutive `> ` lines).
    if (/^>\s?/.test(trimmed)) {
      flushParagraph(paragraph);
      paragraph = [];
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test((lines[i] ?? "").trim())) {
        quote.push((lines[i] ?? "").trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", inline: parseInline(quote.join(" ")) });
      continue;
    }

    // Table: a `| a | b |` header row immediately followed by a `| --- | --- |` separator.
    const nextLine = (lines[i + 1] ?? "").trim();
    if (/^\|.*\|$/.test(trimmed) && /^\|[\s:|-]+\|$/.test(nextLine)) {
      flushParagraph(paragraph);
      paragraph = [];
      const header = splitRow(trimmed).map(parseInline);
      i += 2; // consume header + separator
      const rows: SiteInline[][][] = [];
      while (i < lines.length && /^\|.*\|$/.test((lines[i] ?? "").trim())) {
        rows.push(splitRow((lines[i] ?? "").trim()).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    // List (consecutive `- ` / `* ` unordered or `1. ` ordered items).
    const unordered = /^[-*]\s+(.*)$/.exec(trimmed);
    const ordered = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (unordered || ordered) {
      flushParagraph(paragraph);
      paragraph = [];
      const isOrdered = Boolean(ordered);
      const items: SiteInline[][] = [];
      while (i < lines.length) {
        const t = (lines[i] ?? "").trim();
        const u = /^[-*]\s+(.*)$/.exec(t);
        const o = /^\d+\.\s+(.*)$/.exec(t);
        if (isOrdered && o) items.push(parseInline(o[1] ?? ""));
        else if (!isOrdered && u) items.push(parseInline(u[1] ?? ""));
        else break;
        i++;
      }
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    // Otherwise: a paragraph line (joined with following non-blank lines).
    paragraph.push(trimmed);
    i++;
  }
  flushParagraph(paragraph);
  return blocks;
}

/** Strip markdown to a plain-text excerpt (for meta descriptions / list summaries). */
export function plainTextExcerpt(md: string, maxLen = 160): string {
  const text = md
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l)) // drop heading lines
    .join(" ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1") // links → text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold → text
    .replace(/[#>*_`|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1).replace(/\s+\S*$/, "") + "…";
}
