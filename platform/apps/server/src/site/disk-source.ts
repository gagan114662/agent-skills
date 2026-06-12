/**
 * The disk-backed {@link ContentSource} for the marketing site (#153). Reads committed markdown from
 * `content/site/<section>/*.md`. The root is resolved from `SITE_CONTENT_DIR` (set per deploy) or by
 * walking up from cwd to find a `content/site` directory — so it works both in `apps/server` during
 * dev/CI and from the built image. Missing directories/files degrade to empty rather than throwing, so
 * a deploy that hasn't shipped content yet renders an empty (not broken) site.
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContentSource, SiteSection } from "./content.js";

/** Resolve the `content/site` root: explicit env, else the nearest ancestor of cwd that has one. */
export function defaultContentRoot(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.SITE_CONTENT_DIR) return resolve(env.SITE_CONTENT_DIR);
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "content", "site");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the conventional repo location relative to cwd (apps/server → platform/content/site).
  return resolve(cwd, "..", "..", "content", "site");
}

/** A disk-backed content source rooted at `root` (defaults to {@link defaultContentRoot}). */
export function createDiskContentSource(root: string = defaultContentRoot()): ContentSource {
  const sectionDir = (section: SiteSection): string => join(root, section);
  const slugOf = (file: string): string => file.replace(/\.md$/, "");

  return {
    async list(section) {
      const dir = sectionDir(section);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return [];
      }
      const out: { slug: string; raw: string }[] = [];
      for (const file of files.sort()) {
        if (!file.endsWith(".md")) continue;
        try {
          const raw = await readFile(join(dir, file), "utf8");
          out.push({ slug: slugOf(file), raw });
        } catch {
          // Skip an unreadable file rather than failing the whole listing.
        }
      }
      return out;
    },
    async read(section, slug) {
      // Guard against path traversal — a slug is a flat filename, never a path.
      if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) return undefined;
      try {
        return await readFile(join(sectionDir(section), `${slug}.md`), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}
