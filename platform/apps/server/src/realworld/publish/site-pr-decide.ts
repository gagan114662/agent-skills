/**
 * The pure plan for a self-publish-to-ipop.ai request (#250). No IO. Turns an agent's free-text request
 * (a title + content) into a SAFE, deterministic commit plan: a slugged filename under the repo's
 * content dir, a branch name, and a PR title/body. The slug is the security boundary — it is restricted
 * to `[a-z0-9-]`, so the derived path can never escape the content dir (no `..`, no absolute path, no
 * injection into the GitHub path). Deterministic (no clock / no randomness) so the same request maps to
 * the same branch — which is exactly what makes the provider's re-publish idempotent.
 */

/** Content file extensions the fleet may publish (text formats a static site renders). */
export const PUBLISHABLE_EXTENSIONS = ["md", "mdx", "html", "txt"] as const;
export type PublishableExtension = (typeof PUBLISHABLE_EXTENSIONS)[number];

const MAX_SLUG_LEN = 80;

export interface PublishToIpopRequest {
  /** PR title + commit message + (default) the source of the slug. */
  title: string;
  /** The file body to commit (markdown / HTML / text). */
  content: string;
  /** Optional explicit slug for the filename; derived from the title when absent. */
  slug?: string;
  /** Optional PR description; defaults to a one-line note. */
  body?: string;
  /** File extension; defaults to `md`. Must be one of {@link PUBLISHABLE_EXTENSIONS}. */
  extension?: string;
}

export interface PublishToIpopPlan {
  ok: true;
  slug: string;
  /** Repo-relative path, e.g. `content/blog/my-post.md` — guaranteed inside `contentDir`. */
  path: string;
  branch: string;
  title: string;
  body: string;
  content: string;
}

export interface PublishToIpopRejection {
  ok: false;
  reason: string;
}

export interface DecidePublishOptions {
  /** Repo dir new files are committed under (e.g. `content/blog`). Normalised here. */
  contentDir: string;
}

/**
 * Working-notes / agent-chatter markers (#250). A self-publish body that contains any of these is an
 * internal artifact — A2A handoff chatter, an SEO planning scratchpad, or a "leave this for a human"
 * note — never a finished post. Matched case-insensitively as a substring of the body. This is the
 * content-quality boundary that stops the fleet from opening debris blog PRs out of its own scratch.
 */
const CHATTER_MARKERS: readonly string[] = [
  "@scout",
  "@quill",
  "[a2a handoff",
  "handoff-chain",
  "keyword pick:",
  "target keyword:",
  "meta description:",
  "suggested url",
  "nothing publishes",
  "draft only",
  "for a human to review",
  "notes for the human reviewer",
];

/** Sentence-ending punctuation a finished post's last visible line must close on. */
const SENTENCE_END = /[.!?:")]$/;

/** A line that is entirely a markdown link / linked badge, e.g. `[t](u)`, `![a](s)`, `[![a](s)](u)`. */
function isMarkdownLinkLine(line: string): boolean {
  return /^!?\[.*\]\([^)]*\)$/.test(line);
}

/**
 * True when the body looks cut off mid-thought (#250). After trimming and ignoring a single trailing
 * markdown link/badge line (the #399 "Built with ipop" footer is exactly such a line), the final visible
 * line of a finished post ends on sentence-ending punctuation; a truncated draft does not.
 */
function looksTruncated(content: string): boolean {
  const lines = content.split(/\r?\n/);
  const dropTrailingBlanks = (): void => {
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  };
  dropTrailingBlanks();
  // Ignore a single trailing link/badge line so a real post that ends in a sentence + an attribution
  // badge isn't misread as truncated.
  if (lines.length > 1 && isMarkdownLinkLine((lines[lines.length - 1] ?? "").trim())) {
    lines.pop();
    dropTrailingBlanks();
  }
  const finalLine = (lines[lines.length - 1] ?? "").trim();
  if (finalLine === "") return true; // nothing visible left ⇒ incomplete
  return !SENTENCE_END.test(finalLine);
}

/**
 * Validate + plan a publish request. Rejects empty title/content, an internal/incomplete draft (#250 —
 * agent chatter markers or a truncated body), an unslugglable title, and an unknown extension. On success
 * returns a deterministic, traversal-proof commit plan.
 */
export function decidePublishToIpop(
  req: PublishToIpopRequest,
  opts: DecidePublishOptions,
): PublishToIpopPlan | PublishToIpopRejection {
  const title = (req.title ?? "").trim();
  if (!title) return { ok: false, reason: "a title is required" };
  const content = req.content ?? "";
  if (!content.trim()) return { ok: false, reason: "content is required" };

  // #250 content-quality gate: the body must read as a finished post, never an internal/working draft.
  const lower = content.toLowerCase();
  const marker = CHATTER_MARKERS.find((m) => lower.includes(m));
  if (marker) {
    return { ok: false, reason: `content looks like an internal draft (contains "${marker}") — not publishable` };
  }
  if (looksTruncated(content)) {
    return { ok: false, reason: "content looks truncated (does not end on a complete sentence) — not publishable" };
  }

  const ext = (req.extension ?? "md").trim().toLowerCase().replace(/^\./, "");
  if (!(PUBLISHABLE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, reason: `extension must be one of ${PUBLISHABLE_EXTENSIONS.join(", ")}` };
  }

  const slug = slugify(req.slug && req.slug.trim() ? req.slug : title);
  if (!slug) return { ok: false, reason: "could not derive a URL-safe slug from the title/slug" };

  const contentDir = normaliseDir(opts.contentDir);
  const path = `${contentDir}/${slug}.${ext}`;
  const branch = `ipop-content/${slug}`;
  const body = (req.body ?? "").trim() || `Adds \`${path}\` — drafted by the ipop fleet (#250).`;

  return { ok: true, slug, path, branch, title, body, content };
}

/** Lowercase, collapse non-alphanumerics to single hyphens, trim, and cap length. Charset `[a-z0-9-]`. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
}

/** Normalise a content dir: drop leading/trailing slashes and any `..` / `.` segments (traversal-proof). */
function normaliseDir(dir: string): string {
  const segments = (dir || "content/blog")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..");
  return segments.length > 0 ? segments.join("/") : "content/blog";
}
