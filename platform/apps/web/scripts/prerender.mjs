/**
 * Prerender step (#252). Runs AFTER `vite build` (client) and `vite build --ssr` (server bundle).
 *
 * It takes the built `dist/index.html` shell — which on its own ships an empty `<div id="root">` that
 * crawlers see as a blank page — and writes static HTML for every public marketing surface with the
 * real body baked in: the homepage, the blog index, and every published blog post. It also emits
 * `sitemap.xml` and `robots.txt`. The browser still loads the full interactive SPA on top (createRoot
 * cleanly replaces the prerendered markup), so visitors get the identical experience while crawlers and
 * link unfurlers get real, indexable content.
 *
 * All the HTML/XML generation is pure and unit-tested (`src/blog/seo.ts`); this script is just the
 * orchestration + filesystem I/O.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const DIST = join(WEB_ROOT, "dist");
const SSR_BUNDLE = join(WEB_ROOT, "dist-ssr", "entry-server.js");

async function main() {
  // Pull the rendered pages + pure helpers out of the SSR bundle.
  const { prerenderPages, resolveOrigin, resolveBuildSha, injectBuildStamp, injectPage, buildSitemap, buildRobots } = await import(
    pathToFileURL(SSR_BUNDLE).href
  );

  const origin = resolveOrigin(process.env);
  const buildSha = resolveBuildSha(process.env);
  const template = await readFile(join(DIST, "index.html"), "utf8");

  // Guard: if Vite ever stops shipping the empty root div, our injection would silently no-op — fail loud.
  if (!/<div id="root">\s*<\/div>/.test(template)) {
    throw new Error("prerender: could not find an empty <div id=\"root\"></div> in dist/index.html");
  }

  const pages = prerenderPages();
  const written = [];

  for (const page of pages) {
    const finalHtml = injectBuildStamp(injectPage(template, page, origin), buildSha);
    const outPath = join(DIST, page.outFile);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, finalHtml, "utf8");
    written.push(`${page.urlPath} → dist/${page.outFile}`);
  }

  // Sitemap + robots at the dist root.
  await writeFile(join(DIST, "sitemap.xml"), buildSitemap(origin, pages), "utf8");
  await writeFile(join(DIST, "robots.txt"), buildRobots(origin), "utf8");

  console.log(`prerender: origin ${origin}`);
  console.log(`prerender: build sha ${buildSha ?? "unstamped"}`);
  for (const line of written) console.log(`  ${line}`);
  console.log(`  /sitemap.xml → dist/sitemap.xml (${pages.length} urls)`);
  console.log(`  /robots.txt  → dist/robots.txt`);
}

main().catch((err) => {
  console.error("prerender failed:", err);
  process.exit(1);
});
