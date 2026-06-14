import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import type { ContentSource, SiteSection } from "../../src/site/content.js";
import { buildContentPublish } from "../../src/site/publish.js";

/**
 * #153 marketing-site machine — the public CMS-lite API serves only published repo markdown, and EVERY
 * publish is the existing #13 `external.send` gate (proven end-to-end against the unchanged `/actions`
 * path). The content store is injected in-memory so the test is hermetic.
 */

const FILES: Record<string, Record<string, string>> = {
  compare: {
    "vs-diy": `---\ntitle: ipop vs. DIY\nslug: vs-diy\nstatus: published\nagent: quill\n---\n\n# Heads up\n\nA **bold** point and a [link](https://ipop.ai).`,
    "secret-draft": `---\ntitle: Secret\nstatus: draft\n---\n\nNot ready.`,
  },
  changelog: {
    "2026-06-08": `---\ntitle: Week of 2026-06-08\nstatus: published\nagent: echo\norder: 1\n---\n\n### New\n\n- Shipped a thing (#1)`,
  },
  stories: {},
  guides: {},
};

const memSource: ContentSource = {
  async list(section: SiteSection) {
    return Object.entries(FILES[section] ?? {}).map(([slug, raw]) => ({ slug, raw }));
  },
  async read(section: SiteSection, slug: string) {
    return FILES[section]?.[slug];
  },
};

let app: FastifyInstance;
const slugs: string[] = [];

beforeAll(async () => {
  app = buildApp({ contentSource: memSource });
  await app.ready();
});

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await closeDb();
});

describe("#153 public marketing-site content API", () => {
  it("lists only published docs in a section (drafts are invisible)", async () => {
    const res = await app.inject({ method: "GET", url: "/site/content/compare" });
    expect(res.statusCode).toBe(200);
    const slugsOut = res.json().docs.map((d: { slug: string }) => d.slug);
    expect(slugsOut).toEqual(["vs-diy"]);
  });

  it("renders a published doc body to typed blocks (no HTML)", async () => {
    const res = await app.inject({ method: "GET", url: "/site/content/compare/vs-diy" });
    expect(res.statusCode).toBe(200);
    const { doc } = res.json();
    expect(doc.title).toBe("ipop vs. DIY");
    expect(doc.agent).toBe("quill");
    expect(doc).not.toHaveProperty("body"); // body is replaced by structured blocks
    const types = doc.blocks.map((b: { type: string }) => b.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
  });

  it("404s a draft and an unknown slug/section", async () => {
    expect((await app.inject({ method: "GET", url: "/site/content/compare/secret-draft" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/site/content/compare/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/site/content/bogus" })).statusCode).toBe(404);
  });

  it("serves the changelog newest-first", async () => {
    const res = await app.inject({ method: "GET", url: "/site/changelog" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries[0].slug).toBe("2026-06-08");
  });

  it("needs no auth (it is public)", async () => {
    expect((await app.inject({ method: "GET", url: "/site/content/compare" })).statusCode).toBe(200);
  });
});

describe("#153 publishing ships autonomously (#243 money-only)", () => {
  async function newOwner() {
    const slug = `site-${newId()}`;
    slugs.push(slug);
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "Owner", workspaceSlug: slug },
    });
    const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
    const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
    return { cookie, workspaceId: me.workspaceId as string };
  }

  it("publishing a page executes autonomously — no money, no owner prompt (#243)", async () => {
    const owner = await newOwner();
    // The agent that drafted the content is registered so it can submit the publish.
    const reg = (
      await app.inject({
        method: "POST",
        url: `/workspaces/${owner.workspaceId}/agents`,
        cookies: { rid: owner.cookie },
        payload: { name: "Quill" },
      })
    ).json();

    const action = buildContentPublish({
      section: "compare",
      slug: "vs-diy",
      title: "ipop vs. DIY",
      agent: "quill",
    });

    // Content publishing carries no money → under #243 it ships on its own, with no parked approval.
    const submit = await app.inject({
      method: "POST",
      url: `/workspaces/${owner.workspaceId}/actions`,
      headers: { authorization: `Bearer ${reg.token}` },
      payload: { actionType: action.actionType, payload: action.payload, amount: action.amount },
    });
    expect(submit.statusCode).toBe(200);
    expect(submit.json().status).toBe("executed");

    // Nothing parked for the owner.
    const pending = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${owner.workspaceId}/approvals?status=pending`,
        cookies: { rid: owner.cookie },
      })
    ).json();
    expect(pending).toHaveLength(0);
  });
});
