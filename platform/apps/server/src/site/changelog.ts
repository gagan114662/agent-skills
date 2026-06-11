/**
 * The changelog drafter (#153). Pure: turns merged-PR titles (conventional-commit style) into a
 * release-notes draft in the house voice — the "echo summarises → owner approves → publish" loop,
 * pointed at ourselves. The draft is then publish-gated through the #13 `external.send` path
 * (`publish.ts`) before it ever reaches the public site. Dependency-free so it runs in the unit job
 * and in a weekly GitHub Action that opens a gated draft.
 */

/** A merged pull request, as the drafter needs it. */
export interface MergedPr {
  title: string;
  number?: number;
}

/** A parsed conventional-commit PR title. */
export interface ParsedPrTitle {
  /** Lowercased type, e.g. `feat` / `fix` / `docs`; `other` when the title isn't conventional. */
  type: string;
  /** Optional scope inside the parens, e.g. `#153` or `web`. */
  scope?: string;
  /** True when the title marks a breaking change (`feat!:` or `feat(x)!:`). */
  breaking: boolean;
  /** The human summary after the colon (or the whole title when not conventional). */
  summary: string;
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;

/**
 * Parse one PR-list line into a {@link MergedPr}, pulling a trailing `(#123)` or leading `#123` into the
 * number. Returns null for a blank line. Used by the changelog CLI to read `gh pr list` output.
 */
export function parsePrLine(line: string): MergedPr | null {
  const t = line.trim();
  if (!t) return null;
  const trailing = /^(.*?)\s*\(#(\d+)\)\s*$/.exec(t);
  if (trailing) return { title: trailing[1]!.trim(), number: Number(trailing[2]) };
  const leading = /^#(\d+)\s+(.*)$/.exec(t);
  if (leading) return { title: leading[2]!.trim(), number: Number(leading[1]) };
  return { title: t };
}

/** Parse a conventional-commit PR title; falls back to `{ type: "other", summary: title }`. */
export function parsePrTitle(title: string): ParsedPrTitle {
  const m = CONVENTIONAL.exec(title.trim());
  if (!m) return { type: "other", breaking: false, summary: title.trim() };
  const [, type, scope, bang, summary] = m;
  return {
    type: (type ?? "other").toLowerCase(),
    ...(scope ? { scope } : {}),
    breaking: bang === "!",
    summary: (summary ?? title).trim(),
  };
}

/** How each conventional type rolls up into a public-facing changelog group. */
const GROUPS: { heading: string; types: string[] }[] = [
  { heading: "New", types: ["feat"] },
  { heading: "Fixed", types: ["fix"] },
  { heading: "Improved", types: ["perf", "refactor", "docs", "build", "ci", "style", "revert", "other", "chore"] },
];

export interface ChangelogDraft {
  /** Section slug, e.g. `2026-06-week-2`. */
  slug: string;
  /** Display title, e.g. `Week of 2026-06-08`. */
  title: string;
  /** One-line house-voice summary (the review-queue line). */
  summary: string;
  /** The markdown body, grouped New / Fixed / Improved, ready to commit with `status: published`. */
  body: string;
  /** The agent credited with the draft. */
  agent: "echo";
}

function refOf(pr: MergedPr): string {
  return typeof pr.number === "number" ? ` (#${pr.number})` : "";
}

/** Capitalise the first letter so bullets read as sentences. */
function sentence(text: string): string {
  return text.length > 0 ? (text[0] ?? "").toUpperCase() + text.slice(1) : text;
}

/**
 * Draft a week's changelog from the merged PRs. `weekOf` is the ISO date the week starts (e.g.
 * `2026-06-08`); it drives the slug and title. Empty input still produces a valid (quiet) entry.
 */
export function draftChangelog(prs: MergedPr[], weekOf: string): ChangelogDraft {
  const parsed = prs.map((pr) => ({ pr, info: parsePrTitle(pr.title) }));
  const sections: string[] = [];
  let shipped = 0;

  for (const group of GROUPS) {
    const inGroup = parsed.filter(({ info }) => group.types.includes(info.type));
    if (inGroup.length === 0) continue;
    sections.push(`### ${group.heading}`);
    for (const { pr, info } of inGroup) {
      const flag = info.breaking ? "**Breaking:** " : "";
      sections.push(`- ${flag}${sentence(info.summary)}${refOf(pr)}`);
      shipped++;
    }
    sections.push("");
  }

  const title = `Week of ${weekOf}`;
  const summary =
    shipped === 0
      ? "A quiet week — no merged changes to report."
      : `${shipped} change${shipped === 1 ? "" : "s"} shipped this week — drafted by Echo, approved by a human.`;

  const body =
    sections.length > 0
      ? sections.join("\n").trimEnd() + "\n"
      : "Nothing shipped this week. The agents were thinking.\n";

  return {
    slug: `${weekOf}`,
    title,
    summary,
    body,
    agent: "echo",
  };
}
