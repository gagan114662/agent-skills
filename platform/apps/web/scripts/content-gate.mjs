#!/usr/bin/env node
/**
 * content-gate.mjs (#527) — the content editorial/lint gate, as a CLI.
 *
 * Runs the pure rules in `content-gate-core.mjs` over the committed blog posts and FAILS (exit 1) on any
 * violation: malformed/missing frontmatter, internal agent-chatter markers in public fields, a slug that
 * near-duplicates an existing post, a slug that does not match its filename, or `status: published` for a
 * slug that is not in the human-maintained `published-allowlist.txt`.
 *
 * Two wirings, one gate:
 *   • CI  — a blocking step in `platform-ci.yml` (`node apps/web/scripts/content-gate.mjs`).
 *   • Pre-PR hook — `scripts/hooks/pre-push` calls this before a push leaves the machine.
 *
 * Modes:
 *   (default)         lint every content/blog/*.md (history-independent — works in shallow CI checkouts).
 *   --changed [base]  lint only files changed vs <base> (default origin/main); faster for the local hook.
 *
 * Dependency-free; mirrors the style of platform/scripts/check-*.mjs.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  lintPost,
  lintSiteResource,
  parseAllowlist,
  parseFrontmatter,
  SITE_RESOURCE_SECTIONS,
} from "./content-gate-core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, "..");
const BLOG_DIR = path.join(WEB_ROOT, "content", "blog");
const SITE_DIR = path.resolve(WEB_ROOT, "..", "..", "content", "site");
const ALLOWLIST_FILE = path.join(WEB_ROOT, "content", "published-allowlist.txt");

function listBlogFiles() {
  if (!existsSync(BLOG_DIR)) return [];
  return readdirSync(BLOG_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.join(BLOG_DIR, f))
    .sort();
}

function listSiteFiles() {
  if (!existsSync(SITE_DIR)) return [];
  return SITE_RESOURCE_SECTIONS.flatMap((section) => {
    const dir = path.join(SITE_DIR, section);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ section, path: path.join(dir, f) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  });
}

/** Files changed vs <base>, restricted to content/blog and content/site markdown files still present. */
function changedContentFiles(base) {
  const repoRoot = path.resolve(WEB_ROOT, "..", "..", "..");
  let out = "";
  try {
    out = execSync(`git diff --name-only ${base}...HEAD`, { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return null;
  }
  const lines = out.split("\n").map((l) => l.trim());
  const blogs = lines
    .filter((l) => /platform\/apps\/web\/content\/blog\/.+\.md$/.test(l))
    .map((l) => path.join(repoRoot, l))
    .filter((p) => existsSync(p));
  const site = lines
    .map((l) => {
      const match = /^platform\/content\/site\/(compare|guides|changelog)\/(.+\.md)$/.exec(l);
      if (!match) return null;
      const p = path.join(repoRoot, l);
      return existsSync(p) ? { section: match[1], path: p } : null;
    })
    .filter(Boolean);
  return { blogs, site };
}

function main() {
  const args = process.argv.slice(2);
  const changedIdx = args.indexOf("--changed");
  const allFiles = listBlogFiles();
  const allSiteFiles = listSiteFiles();

  let targets = allFiles;
  let siteTargets = allSiteFiles;
  if (changedIdx !== -1) {
    const base = args[changedIdx + 1] && !args[changedIdx + 1].startsWith("--") ? args[changedIdx + 1] : "origin/main";
    const changed = changedContentFiles(base);
    if (changed === null) {
      console.warn(`content-gate: could not diff against ${base}; linting all posts.`);
    } else {
      targets = changed.blogs;
      siteTargets = changed.site;
    }
  }

  const allowlist = existsSync(ALLOWLIST_FILE) ? parseAllowlist(readFileSync(ALLOWLIST_FILE, "utf8")) : new Set();

  // The dup-check corpus is every committed post (each candidate is compared against all *others*).
  const corpus = allFiles.map((p) => {
    const { slug } = lintPost({ path: p, raw: readFileSync(p, "utf8"), publishedAllowlist: allowlist });
    return { slug, path: p };
  });

  let failures = 0;
  for (const file of targets) {
    const raw = readFileSync(file, "utf8");
    const others = corpus.filter((c) => c.path !== file);
    const result = lintPost({ path: file, raw, corpus: others, publishedAllowlist: allowlist });
    if (!result.ok) {
      failures++;
      const rel = path.relative(path.resolve(WEB_ROOT, "..", "..", ".."), file);
      console.error(`\n✖ ${rel}`);
      for (const v of result.violations) console.error(`    [${v.code}] ${v.message}`);
    }
  }

  const publishedBySection = new Map(SITE_RESOURCE_SECTIONS.map((section) => [section, 0]));
  for (const item of allSiteFiles) {
    const { meta } = parseFrontmatter(readFileSync(item.path, "utf8"));
    if (meta.status === "published") publishedBySection.set(item.section, (publishedBySection.get(item.section) ?? 0) + 1);
  }
  for (const section of SITE_RESOURCE_SECTIONS) {
    if ((publishedBySection.get(section) ?? 0) === 0) {
      failures++;
      console.error(`\n✖ platform/content/site/${section}`);
      console.error("    [site-section-empty] section has no published resource docs");
    }
  }

  for (const item of siteTargets) {
    const raw = readFileSync(item.path, "utf8");
    const result = lintSiteResource({ path: item.path, raw, section: item.section });
    if (!result.ok) {
      failures++;
      const rel = path.relative(path.resolve(WEB_ROOT, "..", "..", ".."), item.path);
      console.error(`\n✖ ${rel}`);
      for (const v of result.violations) console.error(`    [${v.code}] ${v.message}`);
    }
  }

  const checked = targets.length + siteTargets.length + SITE_RESOURCE_SECTIONS.length;
  if (failures > 0) {
    console.error(`\ncontent-gate: ${failures} of ${checked} post(s) FAILED the editorial gate.\n`);
    process.exit(1);
  }
  console.log(`content-gate: ${checked} post(s) passed the editorial gate.`);
}

main();
