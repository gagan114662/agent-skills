/**
 * Pure JSON-LD structured-data builders (#294). The live site (audited 2026-06-16) shipped a clean
 * `<head>` — title, description, canonical, Open Graph, Twitter — but **no structured data** on any page,
 * so search engines had to infer the ipop entity, the blog, and each article from prose alone. These
 * builders emit schema.org JSON-LD (Organization + WebSite on the home page, Blog + BreadcrumbList on the
 * index, BlogPosting + BreadcrumbList on each post) that the prerender step (`entry-server.tsx` →
 * `injectPage`) drops into the static `<head>`, so a raw crawl gets the explicit entity graph.
 *
 * Dependency-free and side-effect-free, exactly like {@link ./seo.ts} — the prerender build step and the
 * unit tests share one implementation. Only the canonical-URL helper is reused from seo.ts.
 */
import { canonicalUrl } from "./seo.js";
import type { BlogPostMeta } from "./posts.js";

/** A minimal JSON-LD node (a plain object with an `@type`). Kept loose on purpose — schema.org is wide. */
export type JsonLdNode = Record<string, unknown>;

/** The brand identity referenced by every node, so the Organization is one stable entity across pages. */
const ORG_NAME = "ipop";
const ORG_DESCRIPTION =
  "A marketing team in your messages. Scout, Quill, Echo and the rest read the market, draft useful work, " +
  "and leave receipts while you steer the room.";

function imageUrl(origin: string): string {
  return `${origin}/og-image.png`;
}

/** The Organization node — the stable ipop entity (sameAs left empty until real profiles are confirmed). */
export function organizationLd(origin: string): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: ORG_NAME,
    url: `${origin}/`,
    logo: imageUrl(origin),
    description: ORG_DESCRIPTION,
  };
}

/**
 * The SoftwareApplication node (#467) — declares ipop as the web-based marketing product it is, so a crawler
 * understands the entity (a SaaS BusinessApplication), not just an Organization + WebSite. Deliberately
 * declares NO `offers`/`aggregateRating`: those require a verified price or real rating, and fabricating
 * either is a structured-data violation (and bad faith) — same principled stance as the WebSite SearchAction.
 * Category + operatingSystem + provider is honest and is what lifts ipop into product entity understanding.
 */
export function softwareApplicationLd(origin: string): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: ORG_NAME,
    url: `${origin}/`,
    description: ORG_DESCRIPTION,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    image: imageUrl(origin),
    provider: { "@type": "Organization", name: ORG_NAME, url: `${origin}/` },
  };
}

/** The WebSite node. No SearchAction is declared — the marketing site has no site-search endpoint yet, and
 *  claiming one we don't serve would be a structured-data violation (and bad faith). */
export function websiteLd(origin: string): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: ORG_NAME,
    url: `${origin}/`,
    description: ORG_DESCRIPTION,
    publisher: { "@type": "Organization", name: ORG_NAME, url: `${origin}/` },
  };
}

/** A breadcrumb trail. `items` are `[name, urlPath]` pairs from the site root down to the current page. */
export function breadcrumbLd(origin: string, items: ReadonlyArray<[string, string]>): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, urlPath], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: canonicalUrl(origin, urlPath),
    })),
  };
}

/** The Blog node for the `/blog` index — lists each post as a BlogPosting head (no body). */
export function blogLd(origin: string, posts: ReadonlyArray<BlogPostMeta>): JsonLdNode {
  return {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: `The ${ORG_NAME} blog`,
    url: canonicalUrl(origin, "/blog"),
    publisher: { "@type": "Organization", name: ORG_NAME, url: `${origin}/` },
    blogPost: posts.map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      description: p.description,
      url: canonicalUrl(origin, `/blog/${p.slug}`),
      ...(p.date ? { datePublished: p.date, dateModified: p.date } : {}),
      author: { "@type": "Person", name: p.author },
    })),
  };
}

/** The BlogPosting node for a single article page. */
export function blogPostingLd(origin: string, post: BlogPostMeta): JsonLdNode {
  const url = canonicalUrl(origin, `/blog/${post.slug}`);
  return {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    url,
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    image: imageUrl(origin),
    ...(post.date ? { datePublished: post.date, dateModified: post.date } : {}),
    author: { "@type": "Person", name: post.author },
    publisher: {
      "@type": "Organization",
      name: ORG_NAME,
      url: `${origin}/`,
      logo: { "@type": "ImageObject", url: imageUrl(origin) },
    },
  };
}

/**
 * Serialize one or more JSON-LD nodes into a `<script type="application/ld+json">` block, safe to embed in
 * HTML. `<`, `>`, and `&` are unicode-escaped so a value can never break out of the script element (the
 * standard XSS-safe JSON-LD embedding) — defence in depth even though every value here is our own copy.
 */
export function renderJsonLd(nodes: JsonLdNode | JsonLdNode[]): string {
  const payload = Array.isArray(nodes) ? nodes : [nodes];
  const json = JSON.stringify(payload.length === 1 ? payload[0] : payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `<script type="application/ld+json">${json}</script>`;
}
