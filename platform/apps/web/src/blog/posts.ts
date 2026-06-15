/**
 * The blog's content store (#252). Blog posts are committed markdown under `apps/web/content/blog/*.md`
 * — a dedicated, build-time content home so the blog can be *prerendered to static HTML* (crawlers see
 * real article text, not an empty client-rendered shell). Fleet agents (Scout for SEO, Quill for
 * long-form) add an article by dropping a new `.md` file here; the next build picks it up, prerenders a
 * `/blog/<slug>` page, and lists it on `/blog`.
 *
 * Vite inlines every match of the glob at build time (`eager`, `?raw`), so the same content powers both
 * the browser bundle (client-side navigation) and the SSR prerender — no filesystem access at runtime,
 * no API round-trip, nothing to go stale between the two surfaces.
 */
import type { SiteBlock } from "../api/types.js";
import { parseFrontmatter, type Frontmatter } from "./frontmatter.js";
import { renderMarkdown, plainTextExcerpt } from "./markdown.js";

/** A blog post's listing metadata (no body — keeps the index light). */
export interface BlogPostMeta {
  slug: string;
  title: string;
  description: string;
  /** The fleet agent credited with authoring it (the dogfood: `scout` / `quill` / `echo`). */
  author: string;
  /** ISO date string (publish date), or "" if unset. */
  date: string;
  /** Optional reading-time hint ("4 min read"), computed from the body. */
  readingTime: string;
}

/** A full blog post: its metadata plus the rendered body blocks. */
export interface BlogPost extends BlogPostMeta {
  blocks: SiteBlock[];
}

function scalar(meta: Frontmatter, key: string, fallback = ""): string {
  const v = meta[key];
  return typeof v === "string" ? v : fallback;
}

/** ~200 words/min, rounded up, min 1 — a friendly "4 min read" hint. */
function readingTimeOf(body: string): string {
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  return `${Math.max(1, Math.round(words / 200))} min read`;
}

/** The slug for a post: explicit frontmatter `slug`, else the filename without extension. */
function slugFromPath(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/, "");
}

function toPost(path: string, raw: string): BlogPost | null {
  const { meta, body } = parseFrontmatter(raw);
  // Only published posts ever reach the public blog — a draft stays invisible until its frontmatter
  // flips to `status: published` and a human commits it (mirrors the #153 marketing-site publish gate).
  if (scalar(meta, "status") !== "published") return null;
  const slug = scalar(meta, "slug", slugFromPath(path));
  if (!slug) return null;
  const title = scalar(meta, "title", slug);
  const description = scalar(meta, "description") || plainTextExcerpt(body);
  return {
    slug,
    title,
    description,
    author: scalar(meta, "author", scalar(meta, "agent", "quill")),
    date: scalar(meta, "date"),
    readingTime: readingTimeOf(body),
    blocks: renderMarkdown(body),
  };
}

// Eagerly inline every blog markdown file as a raw string at build time.
const RAW = import.meta.glob("../../content/blog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const ALL_POSTS: BlogPost[] = Object.entries(RAW)
  .map(([path, raw]) => toPost(path, raw))
  .filter((p): p is BlogPost => p !== null)
  // Newest first; posts with no date sort last (treated as the epoch).
  .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

/** Every published post's full content, newest first. */
export function listPosts(): BlogPost[] {
  return ALL_POSTS;
}

/** Listing metadata for every published post, newest first (no body). */
export function listPostMeta(): BlogPostMeta[] {
  return ALL_POSTS.map(({ blocks: _blocks, ...meta }) => meta);
}

/** One published post by slug, or undefined if it does not exist (or is a draft). */
export function getPost(slug: string): BlogPost | undefined {
  return ALL_POSTS.find((p) => p.slug === slug);
}
