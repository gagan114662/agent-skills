/**
 * The marketing-site CMS-lite (#153): typed access to the repo-markdown content store, over a
 * `ContentSource` seam so the loader is pure and unit-testable (in-memory in tests, disk in prod —
 * `disk-source.ts`). Only `status: published` documents are ever returned to the public site; a draft
 * stays invisible until the #13 publish gate clears and a human commits the flip. Dependency-free.
 */
import { parseFrontmatter, type Frontmatter } from "./frontmatter.js";

/** The content sections the public site serves. Each maps to a directory under `content/site/`. */
export const SITE_SECTIONS = ["compare", "stories", "guides", "changelog"] as const;
export type SiteSection = (typeof SITE_SECTIONS)[number];

export function isSiteSection(value: unknown): value is SiteSection {
  return typeof value === "string" && (SITE_SECTIONS as readonly string[]).includes(value);
}

/** A document's metadata (the list-view shape — no body, so listings stay small). */
export interface SiteDocMeta {
  section: SiteSection;
  slug: string;
  title: string;
  description: string;
  /** The artifact kind, e.g. `compare` / `story` / `guide` / `changelog`. */
  kind: string;
  /** The fleet agent credited with authoring it (the dogfood: `quill` / `scout` / `echo`). */
  agent: string;
  /** ISO date string (publish date). */
  date: string;
  status: "draft" | "published";
  /** Any extra frontmatter keys (competitor label, featured flag, order, …). */
  meta: Frontmatter;
}

/** A full document: its metadata plus the markdown body. */
export interface SiteDoc extends SiteDocMeta {
  body: string;
}

/** The storage seam. Disk-backed in production; in-memory in tests. */
export interface ContentSource {
  /** Every raw markdown file in a section (slug = filename without extension). */
  list(section: SiteSection): Promise<{ slug: string; raw: string }[]>;
  /** One raw markdown file by slug, or undefined if it does not exist. */
  read(section: SiteSection, slug: string): Promise<string | undefined>;
}

function scalar(meta: Frontmatter, key: string, fallback = ""): string {
  const v = meta[key];
  return typeof v === "string" ? v : fallback;
}

/** Parse a raw markdown file into a typed {@link SiteDoc}. Missing `status` defaults to `draft` (safe). */
export function toDoc(section: SiteSection, slug: string, raw: string): SiteDoc {
  const { meta, body } = parseFrontmatter(raw);
  const status = scalar(meta, "status") === "published" ? "published" : "draft";
  return {
    section,
    slug: scalar(meta, "slug", slug),
    title: scalar(meta, "title", slug),
    description: scalar(meta, "description"),
    kind: scalar(meta, "kind", section),
    agent: scalar(meta, "agent", "quill"),
    date: scalar(meta, "date"),
    status,
    meta,
    body,
  };
}

function metaOf(doc: SiteDoc): SiteDocMeta {
  return {
    section: doc.section,
    slug: doc.slug,
    title: doc.title,
    description: doc.description,
    kind: doc.kind,
    agent: doc.agent,
    date: doc.date,
    status: doc.status,
    meta: doc.meta,
  };
}

/**
 * Sort newest-first by `date`, but let an explicit numeric `order` frontmatter key win (ascending) —
 * comparison pages and guides want a curated order; the changelog wants reverse-chronological.
 */
function compareDocs(a: SiteDoc, b: SiteDoc): number {
  const ao = Number(a.meta.order);
  const bo = Number(b.meta.order);
  const aHas = Number.isFinite(ao);
  const bHas = Number.isFinite(bo);
  if (aHas && bHas && ao !== bo) return ao - bo;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return b.date.localeCompare(a.date);
}

/** List the **published** documents in a section (metadata only), in display order. */
export async function loadSection(source: ContentSource, section: SiteSection): Promise<SiteDocMeta[]> {
  const files = await source.list(section);
  return files
    .map((f) => toDoc(section, f.slug, f.raw))
    .filter((d) => d.status === "published")
    .sort(compareDocs)
    .map(metaOf);
}

/** Load one **published** document (with body), or undefined if missing or still a draft. */
export async function loadDoc(
  source: ContentSource,
  section: SiteSection,
  slug: string,
): Promise<SiteDoc | undefined> {
  const raw = await source.read(section, slug);
  if (raw === undefined) return undefined;
  const doc = toDoc(section, slug, raw);
  return doc.status === "published" ? doc : undefined;
}
