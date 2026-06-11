/**
 * A minimal, pure markdown → typed-blocks renderer for the marketing site (#153). It deliberately does
 * NOT emit HTML: it returns a discriminated union of blocks (heading/paragraph/list/quote/code) with
 * inline runs (text/strong/link). The React `Markdown` component maps those to elements, so there is no
 * `dangerouslySetInnerHTML` anywhere — content authored by an agent can never inject markup. Supports
 * the subset cornerstone SEO content needs; pure and total so it runs in the no-DB unit job.
 */

export interface InlineText {
  type: "text";
  text: string;
}
export interface InlineStrong {
  type: "strong";
  text: string;
}
export interface InlineLink {
  type: "link";
  text: string;
  href: string;
}
export type Inline = InlineText | InlineStrong | InlineLink;

export interface HeadingBlock {
  type: "heading";
  level: 1 | 2 | 3;
  inline: Inline[];
}
export interface ParagraphBlock {
  type: "paragraph";
  inline: Inline[];
}
export interface ListBlock {
  type: "list";
  ordered: boolean;
  items: Inline[][];
}
export interface QuoteBlock {
  type: "quote";
  inline: Inline[];
}
export interface CodeBlock {
  type: "code";
  text: string;
}
export interface TableBlock {
  type: "table";
  header: Inline[][];
  rows: Inline[][][];
}
export type Block = HeadingBlock | ParagraphBlock | ListBlock | QuoteBlock | CodeBlock | TableBlock;

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
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
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
export function renderMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
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
      const rows: Inline[][][] = [];
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
      const items: Inline[][] = [];
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
