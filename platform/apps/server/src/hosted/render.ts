/**
 * #266 — the PURE, injection-safe page renderer. Turns a stored hosted page into a complete, servable
 * HTML document. This is the file the premortem (#200 §6) leans on hardest: a page's title/body/
 * description are USER-SUPPLIED DATA (an agent may have folded a poisoned web read into them), so EVERY
 * interpolation is HTML-escaped and the body is rendered as escaped plain-text paragraphs — never as raw
 * HTML. There is no code path by which page content becomes live markup, script, or an attribute break-out.
 *
 * The output is a real, standalone document (doctype + head + body + canonical + Open Graph + JSON-LD), so
 * what a unit test renders is byte-for-byte what the serve path returns — "renders/serves correctly in a
 * real build" is checkable without a browser.
 */

import type { HostedPageKind } from "./decide.js";

/** HTML-escape text for use in element content or a double-quoted attribute. Total. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Embed a value inside a `<script type="application/ld+json">` block safely: JSON.stringify handles quotes,
 * and we additionally escape `<`, `>` and `&` so a body containing the literal `</script>` can never close
 * the block early (the classic JSON-LD XSS). Returns a string ready to drop between the script tags.
 */
function jsonLdSafe(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** Split a body into paragraphs on blank lines and render each as an escaped `<p>` (no raw HTML, ever). */
function renderBodyParagraphs(body: string): string {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paras.length === 0) return "";
  return paras
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br />")}</p>`)
    .join("\n      ");
}

export interface RenderHostedPageInput {
  page: {
    kind: HostedPageKind;
    title: string;
    body: string;
    slug: string;
    description?: string | null;
    /** ISO timestamp the page was published; drives the article date + JSON-LD. */
    publishedAt?: string | null;
  };
  site: {
    name?: string | null;
  };
  /** The canonical public URL ({@link resolveHostedUrl}). */
  url: string;
}

/**
 * Render a complete HTML document for a hosted page. Deterministic + pure: identical input → identical
 * bytes. The article kind emits a `BlogPosting`; the landing kind a `WebPage`. All user fields are escaped.
 */
export function renderHostedPage(input: RenderHostedPageInput): string {
  const { page, site, url } = input;
  const siteName = (site.name ?? "").trim();
  const title = page.title.trim();
  const description = (page.description ?? "").trim() || firstSentence(page.body);
  const headTitle = siteName ? `${title} — ${siteName}` : title;
  const bodyHtml = renderBodyParagraphs(page.body);

  const ld =
    page.kind === "article"
      ? {
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: title,
          description,
          url,
          ...(page.publishedAt ? { datePublished: page.publishedAt } : {}),
        }
      : {
          "@context": "https://schema.org",
          "@type": "WebPage",
          name: title,
          description,
          url,
        };

  const dateLine =
    page.kind === "article" && page.publishedAt
      ? `\n      <p class="hosted-date"><time datetime="${escapeHtml(page.publishedAt)}">${escapeHtml(
          page.publishedAt.slice(0, 10),
        )}</time></p>`
      : "";

  const wrapperTag = page.kind === "article" ? "article" : "section";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(headTitle)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(url)}" />
    <meta property="og:type" content="${page.kind === "article" ? "article" : "website"}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta name="twitter:card" content="summary" />
    <script type="application/ld+json">${jsonLdSafe(ld)}</script>
  </head>
  <body>
    <main>
      <${wrapperTag} class="hosted-page hosted-${page.kind}">
        <h1>${escapeHtml(title)}</h1>${dateLine}
        ${bodyHtml}
      </${wrapperTag}>
    </main>
  </body>
</html>
`;
}

/** First sentence of a body, trimmed to a sane meta-description length (escaping happens at render). */
function firstSentence(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const dot = flat.indexOf(". ");
  const candidate = dot > 0 && dot < 180 ? flat.slice(0, dot + 1) : flat;
  return candidate.slice(0, 180);
}
