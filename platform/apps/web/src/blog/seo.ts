/**
 * Pure SEO/prerender helpers (#252): inject server-rendered body + per-page head meta into the built
 * HTML shell, and generate `sitemap.xml` / `robots.txt`. Kept dependency-free and side-effect-free so
 * the prerender build step (`scripts/prerender.mjs`, which does the fs I/O) and the unit tests share one
 * implementation. The actual page bodies come from `entry-server.tsx`.
 */

/** A page to prerender: where to write it, its canonical path, its body HTML, and its head meta. */
export interface PrerenderPage {
  /** Output path relative to the dist root (e.g. "index.html", "blog/cool-post/index.html"). */
  outFile: string;
  /** Canonical URL path (e.g. "/", "/blog", "/blog/cool-post") — origin is prepended here. */
  urlPath: string;
  /** Static body HTML injected into `<div id="root">…</div>`. */
  html: string;
  /** Per-page `<title>` — when omitted, the built shell's default title is kept (the home page). */
  title?: string;
  /** Per-page meta description — when omitted, the shell's default description is kept. */
  description?: string;
  /** Last-modified date (ISO) for the sitemap entry, if known. */
  lastmod?: string;
  /** Sitemap priority hint (0.0–1.0). */
  priority?: number;
  /** Per-page `og:type` override (e.g. "article" for a post; the shell defaults to "website"). */
  ogType?: string;
  /**
   * Pre-rendered markup to inject immediately before `</head>` (#294): JSON-LD `<script>` blocks and any
   * per-page `<meta property="article:*">` tags. The caller (`entry-server.tsx`) builds this string with
   * the structured-data helpers; it must already be HTML-safe (see `renderJsonLd`).
   */
  headExtra?: string;
  /** HTML language for the document root. */
  lang?: string;
}

/** The production origin. Overridable for previews via SITE_ORIGIN; trailing slash stripped. */
export function resolveOrigin(env: Record<string, string | undefined> = {}): string {
  const raw = env.SITE_ORIGIN || env.VITE_SITE_ORIGIN || "https://ipop.ai";
  return raw.replace(/\/+$/, "");
}

/** Absolute canonical URL for a path. Home is the bare origin with a trailing slash; others have none. */
export function canonicalUrl(origin: string, urlPath: string): string {
  if (urlPath === "/" || urlPath === "") return `${origin}/`;
  return `${origin}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`;
}

/** Minimal HTML-attribute escaping for values we place inside `content="…"` / `<title>…`. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Replace the inner text of the real `<title>…</title>` element. The content class `[^<]*` (rather than
 * a lazy `[\s\S]*?`) is deliberate: the shell's head carries an HTML comment that mentions the literal
 * word `<title>`, and a lazy match would span from that comment to the real closing tag, corrupting both.
 * A title's text never contains `<`, so `[^<]*` matches only the genuine element.
 */
function setTitle(html: string, title: string): string {
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
}

/** Set the `content` of a `<meta name|property="key" …>` tag (no-op if the tag isn't present). */
function setMetaContent(html: string, attr: "name" | "property", key: string, content: string): string {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[\\s\\S]*?(")`, "i");
  return html.replace(re, `$1${escapeHtml(content)}$2`);
}

/** Set the `href` of the `<link rel="canonical" …>` tag. */
function setCanonical(html: string, href: string): string {
  return html.replace(/(<link\s+rel="canonical"\s+href=")[\s\S]*?(")/i, `$1${escapeHtml(href)}$2`);
}

function setHtmlLang(html: string, lang: string): string {
  return html.replace(/(<html\s+lang=")[^"]*(")/i, `$1${escapeHtml(lang)}$2`);
}

/**
 * Produce the final static HTML for one page: inject the SSR body into `#root` and rewrite the head meta
 * (title / description / canonical / Open Graph / Twitter) for this specific URL. The built shell's tags
 * are kept untouched when a page provides no override (the home page keeps its hand-written meta).
 */
export function injectPage(template: string, page: PrerenderPage, origin: string): string {
  let out = template.replace(/<div id="root">\s*<\/div>/, `<div id="root">${page.html}</div>`);
  out = setHtmlLang(out, page.lang ?? "en");

  const canonical = canonicalUrl(origin, page.urlPath);
  out = setCanonical(out, canonical);
  out = setMetaContent(out, "property", "og:url", canonical);

  if (page.title) {
    out = setTitle(out, page.title);
    out = setMetaContent(out, "property", "og:title", page.title);
    out = setMetaContent(out, "name", "twitter:title", page.title);
  }
  if (page.description) {
    out = setMetaContent(out, "name", "description", page.description);
    out = setMetaContent(out, "property", "og:description", page.description);
    out = setMetaContent(out, "name", "twitter:description", page.description);
  }
  if (page.ogType) {
    out = setMetaContent(out, "property", "og:type", page.ogType);
  }
  // Inject JSON-LD + per-page article meta just before </head>. The caller pre-renders this safely; we
  // only place it (no escaping here — `headExtra` is already markup, not a text value).
  if (page.headExtra) {
    out = out.replace(/<\/head>/, `${page.headExtra}\n  </head>`);
  }
  return out;
}

/** Build a urlset `sitemap.xml` from the prerendered pages. */
export function buildSitemap(origin: string, pages: PrerenderPage[]): string {
  const urls = pages
    .map((p) => {
      const loc = escapeHtml(canonicalUrl(origin, p.urlPath));
      const lastmod = p.lastmod ? `\n    <lastmod>${escapeHtml(p.lastmod)}</lastmod>` : "";
      const priority = p.priority != null ? `\n    <priority>${p.priority.toFixed(1)}</priority>` : "";
      return `  <url>\n    <loc>${loc}</loc>${lastmod}${priority}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** Build a `robots.txt` that allows everything and points crawlers at the sitemap. */
export function buildRobots(origin: string): string {
  return `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}
