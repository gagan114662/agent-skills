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
 * Validate + plan a publish request. Rejects empty title/content, an unslugglable title, and an
 * unknown extension. On success returns a deterministic, traversal-proof commit plan.
 */
export function decidePublishToIpop(
  req: PublishToIpopRequest,
  opts: DecidePublishOptions,
): PublishToIpopPlan | PublishToIpopRejection {
  const title = (req.title ?? "").trim();
  if (!title) return { ok: false, reason: "a title is required" };
  const content = req.content ?? "";
  if (!content.trim()) return { ok: false, reason: "content is required" };

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
