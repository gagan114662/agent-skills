/**
 * content-gate-core.mjs (#527) — the pure, dependency-free editorial lint for blog content.
 *
 * The content fleet (Scout, Quill) drops blog posts under `content/blog/*.md`. Without a gate, agent
 * coordination chatter, malformed frontmatter, topic dupes, and `status: published`-by-default leak into
 * public PRs (the seven open content PRs in #527 every one had at least one of these). This module is the
 * single source of truth for the rules; `content-gate.mjs` wraps it as a CLI (CI + pre-push hook) and
 * `content-gate.test.mjs` exercises it. Pure functions only — no fs, no git, no process — so it is trivially
 * testable and reusable.
 *
 * The frontmatter reader here is a deliberately minimal mirror of `src/blog/frontmatter.ts` (top-level
 * scalars are all the gate needs). The two are kept separate because this runs in plain Node (the CLI/hook)
 * while the app copy runs in the Vite/TS bundle — the same JS/TS-boundary split frontmatter.ts itself notes.
 */

/** The frontmatter keys every committed post must declare (non-empty). */
export const REQUIRED_KEYS = ["title", "slug", "description", "author", "date", "status"];

/** The only statuses a post may carry. */
export const VALID_STATUSES = ["draft", "published"];
export const TITLE_MAX_CHARS = 60;
export const DESCRIPTION_MIN_CHARS = 110;
export const DESCRIPTION_MAX_CHARS = 160;
export const SITE_RESOURCE_SECTIONS = ["compare", "guides", "changelog"];
export const REQUIRED_SITE_KEYS = ["title", "slug", "description", "kind", "agent", "date", "status", "receipt", "approval"];

/**
 * Internal agent / channel markers that must never appear in a committed artifact (title, description, or
 * body). These are the A2A-handoff and channel-reasoning tells found across the #527 PRs. Matched
 * case-insensitively. Bare agent names in prose ("Scout reads your site…") are fine — only the `@handle`,
 * the channel tag, and the coordination phrases are banned.
 */
export const INTERNAL_MARKERS = [
  { label: "@scout", pattern: /@scout\b/i },
  { label: "@quill", pattern: /@quill\b/i },
  { label: "handoff", pattern: /handoff/i },
  { label: "#content", pattern: /#content\b/i },
  { label: "drop it", pattern: /\bdrop it\b/i },
  { label: "my pipe", pattern: /\bmy pipe\b/i },
  { label: "for a human to grab", pattern: /for a human to grab/i },
  { label: "A2A", pattern: /\bA2A\b/i },
  { label: "for a human to approve/review", pattern: /for a human to (?:approve|review)/i },
  { label: "for human review", pattern: /for human review/i },
  { label: "nothing leaves the building", pattern: /nothing leaves the building/i },
  { label: "nothing publishes", pattern: /nothing publishes/i },
];

/** Tokens stripped before measuring slug/topic similarity (stopwords, years, junk fragments). */
const STOPWORDS = new Set([
  "a", "an", "and", "the", "for", "in", "of", "to", "is", "it", "on", "at", "with", "you", "your",
  "we", "our", "how", "what", "why", "vs", "or", "so", "as", "but", "by", "do", "does", "be", "are",
  "i", "m", "s", "t", "re", "ll", "ve",
]);

const FENCE = "---";

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a markdown document into `{ meta, body }`. Only top-level `key: value` scalars are read into `meta`
 * (sequences and nested maps are ignored — the gate needs scalars). A document with no leading fence yields
 * an empty `meta` and the verbatim body, which the gate then reports as "missing required keys".
 *
 * @param {string} raw
 * @returns {{ meta: Record<string,string>, body: string }}
 */
export function parseFrontmatter(raw) {
  const normalised = String(raw).replace(/\r\n/g, "\n");
  if (!normalised.startsWith(FENCE + "\n")) {
    return { meta: {}, body: normalised.replace(/^\n+/, "") };
  }
  const end = normalised.indexOf("\n" + FENCE, FENCE.length + 1);
  if (end === -1) {
    return { meta: {}, body: normalised.replace(/^\n+/, "") };
  }
  const block = normalised.slice(FENCE.length + 1, end);
  const body = normalised.slice(end + 1 + FENCE.length).replace(/^\n+/, "");
  /** @type {Record<string,string>} */
  const meta = {};
  for (const line of block.split("\n")) {
    if (line.trim() === "") continue;
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[2].trim() !== "") {
      meta[kv[1]] = unquote(kv[2]);
    }
  }
  return { meta, body };
}

/** The slug a post should declare: its filename without the `.md` extension. */
export function slugFromPath(path) {
  return (String(path).split("/").pop() ?? "").replace(/\.md$/, "");
}

/** Significant tokens of a slug, for near-duplicate detection (stopwords / years / 1-char fragments removed). */
export function significantTokens(slug) {
  return new Set(
    String(slug)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t)),
  );
}

function intersectionSize(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

/**
 * Is `slug` a near-duplicate of `otherSlug`? Two posts are near-duplicates when they share at least
 * `MIN_SHARED` distinctive (non-stopword) topic tokens AND their token sets overlap by Jaccard ≥ `MIN_JACCARD`.
 * The double condition is deliberate: a high Jaccard alone flags short generic slugs that legitimately share
 * the `{ai, marketing, agency}` family (e.g. "…-cost" vs "…-vs-hiring"), so we also require enough *distinctive*
 * overlap before calling it a dupe. Exact-match is handled separately by the caller.
 *
 * @returns {boolean}
 */
export function isNearDuplicateSlug(slug, otherSlug) {
  const MIN_SHARED = 4;
  const MIN_JACCARD = 0.6;
  const a = significantTokens(slug);
  const b = significantTokens(otherSlug);
  if (a.size === 0 || b.size === 0) return false;
  const shared = intersectionSize(a, b);
  if (shared < MIN_SHARED) return false;
  const jaccard = shared / (a.size + b.size - shared);
  return jaccard >= MIN_JACCARD;
}

/**
 * @typedef {{ code: string, message: string }} Violation
 * @typedef {{ slug: string, path?: string }} CorpusEntry
 * @typedef {{ path: string, raw: string, corpus?: CorpusEntry[], publishedAllowlist?: Iterable<string> }} LintOptions
 * @typedef {{ path: string, slug: string, ok: boolean, violations: Violation[] }} LintResult
 */

/**
 * Lint a single content file. Returns every violation found (the gate reports them all at once rather than
 * failing on the first, so an author fixes one round-trip). `corpus` is the set of *other* committed posts to
 * dup-check against; `publishedAllowlist` is the human-maintained set of slugs cleared to publish.
 *
 * @param {LintOptions} opts
 * @returns {LintResult}
 */
export function lintPost(opts) {
  const { path, raw } = opts;
  const corpus = opts.corpus ?? [];
  const allowlist = new Set(opts.publishedAllowlist ?? []);
  /** @type {Violation[]} */
  const violations = [];
  const { meta, body } = parseFrontmatter(raw);

  // 1. Required frontmatter keys present and non-empty.
  for (const key of REQUIRED_KEYS) {
    if (!meta[key] || meta[key].trim() === "") {
      violations.push({ code: "missing-frontmatter", message: `missing required frontmatter key: ${key}` });
    }
  }

  const slug = meta.slug ?? "";
  const expectedSlug = slugFromPath(path);
  const title = meta.title ?? "";
  const description = meta.description ?? "";

  // 2. Slug must match the filename (catches the truncation/drift that ships a slug ≠ its file).
  if (slug && slug !== expectedSlug) {
    violations.push({
      code: "slug-filename-mismatch",
      message: `slug "${slug}" does not match filename "${expectedSlug}"`,
    });
  }

  // 3. Status must be a known value, and publishing requires the explicit allowlist gate.
  const status = meta.status ?? "";
  if (status && !VALID_STATUSES.includes(status)) {
    violations.push({ code: "invalid-status", message: `status "${status}" is not one of ${VALID_STATUSES.join(", ")}` });
  }
  if (status === "published" && slug && !allowlist.has(slug)) {
    violations.push({
      code: "unauthorized-publish",
      message: `status: published but slug "${slug}" is not in the published allowlist — new posts must default to status: draft (add the slug to published-allowlist.txt in a human-reviewed commit to publish)`,
    });
  }

  // 4. No internal agent / channel markers in any public field.
  const haystack = `${title}\n${description}\n${body}`;
  for (const marker of INTERNAL_MARKERS) {
    if (marker.pattern.test(haystack)) {
      violations.push({ code: "internal-marker", message: `contains internal agent/channel marker: "${marker.label}"` });
    }
  }

  if (title && title.length > TITLE_MAX_CHARS) {
    violations.push({
      code: "title-too-long",
      message: `title is ${title.length} characters; keep it at or below ${TITLE_MAX_CHARS}`,
    });
  }
  if (description) {
    if (description.length < DESCRIPTION_MIN_CHARS || description.length > DESCRIPTION_MAX_CHARS) {
      violations.push({
        code: "description-length",
        message: `description is ${description.length} characters; keep it between ${DESCRIPTION_MIN_CHARS} and ${DESCRIPTION_MAX_CHARS}`,
      });
    }
    const bodyStart = body.replace(/^#\s+.*(?:\n|$)/, "").replace(/[#*_[\]()>-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (bodyStart.startsWith(description.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80))) {
      violations.push({
        code: "description-duplicates-body",
        message: "description duplicates the body opener; write a specific search snippet instead",
      });
    }
  }
  if (!/^#\s+\S+/m.test(body)) {
    violations.push({ code: "missing-h1", message: "body must include one H1 heading" });
  }

  // 5. Topic duplication against the existing corpus (exact slug, then near-duplicate).
  if (slug) {
    for (const other of corpus) {
      if (!other.slug || other.slug === slug) continue;
      if (significantTokens(slug).size && isNearDuplicateSlug(slug, other.slug)) {
        violations.push({
          code: "duplicate-topic",
          message: `slug "${slug}" near-duplicates existing post "${other.slug}"`,
        });
      }
    }
  }

  return { path, slug: slug || expectedSlug, ok: violations.length === 0, violations };
}

/**
 * Lint a public marketing-site resource document. These pages are linked from the product footer/nav, so
 * published entries must carry real evidence and approval metadata, not just a title plus the loading
 * ellipsis that caused #1179.
 *
 * @param {{ path: string, raw: string, section: string }} opts
 * @returns {LintResult}
 */
export function lintSiteResource(opts) {
  const { path, raw, section } = opts;
  /** @type {Violation[]} */
  const violations = [];
  const { meta, body } = parseFrontmatter(raw);
  const slug = meta.slug ?? "";
  const expectedSlug = slugFromPath(path);

  for (const key of REQUIRED_SITE_KEYS) {
    if (!meta[key] || meta[key].trim() === "") {
      violations.push({ code: "missing-site-frontmatter", message: `missing required site frontmatter key: ${key}` });
    }
  }

  if (slug && slug !== expectedSlug) {
    violations.push({
      code: "site-slug-filename-mismatch",
      message: `slug "${slug}" does not match filename "${expectedSlug}"`,
    });
  }

  if (meta.status && !VALID_STATUSES.includes(meta.status)) {
    violations.push({ code: "invalid-site-status", message: `status "${meta.status}" is not one of ${VALID_STATUSES.join(", ")}` });
  }

  if (meta.status !== "published") {
    violations.push({ code: "site-not-published", message: `${section} resource "${expectedSlug}" is not published` });
  }

  const expectedKind = section === "guides" ? "guide" : section;
  if (meta.kind && meta.kind !== expectedKind) {
    violations.push({ code: "site-kind-section-mismatch", message: `kind "${meta.kind}" does not match section "${section}"` });
  }

  const trimmedBody = body.trim();
  if (!/^#\s+\S+/m.test(trimmedBody)) {
    violations.push({ code: "site-missing-h1", message: "site resource body must include one H1 heading" });
  }
  if (trimmedBody.length < 600) {
    violations.push({ code: "site-body-too-thin", message: `site resource body is ${trimmedBody.length} chars; publish substantive content` });
  }
  if (/^(?:\.{3}|…)\s*$/m.test(trimmedBody) || /\b(?:todo|coming soon|placeholder)\b/i.test(trimmedBody)) {
    violations.push({ code: "site-placeholder-content", message: "site resource still looks like placeholder content" });
  }

  const haystack = `${meta.title ?? ""}\n${meta.description ?? ""}\n${trimmedBody}`;
  for (const marker of INTERNAL_MARKERS) {
    if (marker.pattern.test(haystack)) {
      violations.push({ code: "site-internal-marker", message: `contains internal agent/channel marker: "${marker.label}"` });
    }
  }

  return { path, slug: slug || expectedSlug, ok: violations.length === 0, violations };
}

/** Parse the published-allowlist file body into a Set of slugs (ignores blanks and `#` comments). */
export function parseAllowlist(raw) {
  return new Set(
    String(raw)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#")),
  );
}
