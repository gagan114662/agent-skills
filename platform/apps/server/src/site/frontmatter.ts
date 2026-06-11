/**
 * A tiny, dependency-free frontmatter parser for the marketing-site CMS-lite (#153). Content lives as
 * repo markdown with a leading `--- … ---` block; pulling in `gray-matter` (+ its `js-yaml` transitive)
 * for a handful of flat scalars and string lists would violate the "no heavy deps" budget the rest of
 * the platform holds. So this supports exactly the subset the site needs: top-level `key: value`
 * scalars and `key:` / indented `- item` string sequences. Pure and total — unit-tested round-trip.
 */

/** A parsed frontmatter value: a scalar string or a sequence of strings. */
export type FrontmatterValue = string | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParsedContent {
  /** The frontmatter map (empty if the document had no `--- … ---` block). */
  meta: Frontmatter;
  /** Everything after the closing fence (or the whole input when there is no frontmatter). */
  body: string;
}

const FENCE = "---";

/** Strip a single pair of matching surrounding quotes from a scalar value. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a markdown document into `{ meta, body }`. A document with no leading `---` fence parses to an
 * empty `meta` and the verbatim body, so non-frontmatter markdown is handled gracefully.
 */
export function parseFrontmatter(raw: string): ParsedContent {
  const normalised = raw.replace(/\r\n/g, "\n");
  if (!normalised.startsWith(FENCE + "\n")) {
    return { meta: {}, body: normalised.replace(/^\n+/, "") };
  }
  const end = normalised.indexOf("\n" + FENCE, FENCE.length + 1);
  if (end === -1) {
    // An unterminated fence is treated as no frontmatter rather than throwing — content stays visible.
    return { meta: {}, body: normalised.replace(/^\n+/, "") };
  }
  const block = normalised.slice(FENCE.length + 1, end);
  const body = normalised.slice(end + 1 + FENCE.length).replace(/^\n+/, "");
  return { meta: parseBlock(block), body };
}

function parseBlock(block: string): Frontmatter {
  const meta: Frontmatter = {};
  const lines = block.split("\n");
  let pendingKey: string | null = null;
  let pendingList: string[] = [];

  const flush = (): void => {
    if (pendingKey !== null) {
      meta[pendingKey] = pendingList;
      pendingKey = null;
      pendingList = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === "") continue;
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && pendingKey !== null) {
      pendingList.push(unquote(item[1] ?? ""));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      const key = kv[1] ?? "";
      const rest = kv[2] ?? "";
      if (rest.trim() === "") {
        // `key:` with nothing after it opens a sequence (collected from the following `- ` lines).
        pendingKey = key;
        pendingList = [];
      } else {
        meta[key] = unquote(rest);
      }
    }
    // Lines that match neither shape are ignored (defensive — a malformed line never throws).
  }
  flush();
  return meta;
}

/** Serialise a `{ meta, body }` document back to markdown — the inverse of {@link parseFrontmatter}. */
export function serializeFrontmatter(meta: Frontmatter, body: string): string {
  const lines: string[] = [FENCE];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const v of value) lines.push(`  - ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(FENCE, "");
  return lines.join("\n") + "\n" + body.replace(/^\n+/, "");
}
