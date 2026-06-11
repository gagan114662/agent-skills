import type { FastifyInstance } from "fastify";
import {
  loadSection,
  loadDoc,
  isSiteSection,
  type ContentSource,
  type SiteSection,
} from "../site/content.js";
import { renderMarkdown } from "../site/markdown.js";
import { createDiskContentSource } from "../site/disk-source.js";

/**
 * The public marketing-site content API (#153). Serves the repo-markdown CMS-lite for the storefront the
 * fleet maintains: comparison pages, customer stories, cornerstone guides, and the changelog. Every
 * endpoint is **unauthenticated** (it serves only `status: published` content — the same class as the
 * health probes) and read-only; nothing here touches tenant data. The markdown body is returned as typed
 * blocks (no HTML), so the web renderer never needs `dangerouslySetInnerHTML`.
 *
 * Publishing is gated elsewhere: a draft becomes public only after the #13 `external.send` gate clears
 * (`site/publish.ts`) and a human commits the `status: published` flip — so a public read can never
 * surface ungated content.
 */
export interface SiteRoutesOptions {
  /** The content store. Defaults to the disk source rooted at `content/site` (override in tests). */
  contentSource?: ContentSource;
}

export async function siteRoutes(app: FastifyInstance, opts: SiteRoutesOptions = {}): Promise<void> {
  const source = opts.contentSource ?? createDiskContentSource();

  // List the published documents in a section (metadata only).
  app.get<{ Params: { section: string } }>("/site/content/:section", async (req, reply) => {
    const { section } = req.params;
    if (!isSiteSection(section)) {
      reply.code(404);
      return { error: "unknown section" };
    }
    return { section, docs: await loadSection(source, section) };
  });

  // One published document, with its body rendered to typed blocks.
  app.get<{ Params: { section: string; slug: string } }>(
    "/site/content/:section/:slug",
    async (req, reply) => {
      const { section, slug } = req.params;
      if (!isSiteSection(section)) {
        reply.code(404);
        return { error: "unknown section" };
      }
      const doc = await loadDoc(source, section as SiteSection, slug);
      if (!doc) {
        reply.code(404);
        return { error: "not found" };
      }
      const { body, ...meta } = doc;
      return { doc: { ...meta, blocks: renderMarkdown(body) } };
    },
  );

  // The changelog is just the `changelog` section, newest-first — a convenience alias for the page.
  app.get("/site/changelog", async () => {
    return { entries: await loadSection(source, "changelog") };
  });
}
