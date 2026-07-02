import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * #271 — brand kit + asset store + on-brand image generation, end-to-end on a real Postgres.
 *
 * Proves the two acceptance facts the issue calls out:
 *  - An agent (via the server real-world surface) generates an ON-BRAND image attached to a draft: the
 *    image is rejected until a brand kit exists, then generated, stamped with the kit id + draft link,
 *    and persisted to the per-workspace asset store.
 *  - The founder-console brand proof tile FLIPS to connected after a one-time brand setup (it reads "not
 *    connected" before, and connected with the live asset count after).
 *
 * Money-only gating (#243) + injection-quarantine (#223) stay intact: generation never parks a #13
 * approval (it completes autonomously), and the asset surface has no web-reader/send/spend seam.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function seed(): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `bk-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId };
}

function brandTile(consoleBody: { proofScorecard: { tiles: Array<{ department: string }> } }) {
  return consoleBody.proofScorecard.tiles.find((t) => t.department === "brand") as {
    department: string;
    connection: string;
    value: number | null;
    display: string;
    source: string;
  };
}

describe("brand kit (#271) — set once, GET/PUT /me/brand-kit", () => {
  it("starts unset, rejects an invalid kit, then persists the kit the owner sets", async () => {
    const { cookie } = await seed();

    const before = await app.inject({ method: "GET", url: "/me/brand-kit", cookies: { rid: cookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json().connected).toBe(false);

    const bad = await app.inject({
      method: "PUT",
      url: "/me/brand-kit",
      cookies: { rid: cookie },
      payload: { name: "", palette: ["not-a-hex"] },
    });
    expect(bad.statusCode).toBe(400);

    const put = await app.inject({
      method: "PUT",
      url: "/me/brand-kit",
      cookies: { rid: cookie },
      payload: { name: "Acme", palette: ["#FF0000", "#00FF00"], voice: "Bold and friendly." },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().brandKit.palette).toEqual(["#ff0000", "#00ff00"]);

    const after = await app.inject({ method: "GET", url: "/me/brand-kit", cookies: { rid: cookie } });
    expect(after.json().connected).toBe(true);
    expect(after.json().brandKit.name).toBe("Acme");
  });

  it("distills owner draft edits into a confirmed brand voice update (#1543)", async () => {
    const { cookie } = await seed();
    await app.inject({
      method: "PUT",
      url: "/me/brand-kit",
      cookies: { rid: cookie },
      payload: { name: "Acme", palette: ["#1a73e8"], voice: "Warm and concise." },
    });

    const suggest = await app.inject({
      method: "POST",
      url: "/me/brand-voice/learn",
      cookies: { rid: cookie },
      payload: {
        originalDraft: "Guaranteed growth with magical automation!!!",
        editedDraft: "Show the receipt: Scout found the gap, Quill drafted the first useful move.",
        sourceUrls: ["https://acme.test"],
      },
    });
    expect(suggest.statusCode).toBe(200);
    expect(suggest.json()).toMatchObject({
      applied: false,
      activeBrandKit: true,
      suggestion: {
        confirmationRequired: true,
        artifact: { kind: "brand_voice" },
      },
    });

    const unchanged = await app.inject({ method: "GET", url: "/me/brand-kit", cookies: { rid: cookie } });
    expect(unchanged.json().brandKit.voice).toBe("Warm and concise.");

    const apply = await app.inject({
      method: "POST",
      url: "/me/brand-voice/learn",
      cookies: { rid: cookie },
      payload: {
        originalDraft: "Guaranteed growth with magical automation!!!",
        editedDraft: "Show the receipt: Scout found the gap, Quill drafted the first useful move.",
        sourceUrls: ["https://acme.test"],
        confirm: true,
      },
    });
    expect(apply.statusCode).toBe(200);
    expect(apply.json().applied).toBe(true);
    expect(apply.json().brandKit.voice).toContain("Existing voice notes: Warm and concise.");
    expect(apply.json().brandKit.voice).toContain("Avoid:");
  });
});

describe("on-brand image generation (#271) — POST /me/realworld/generate-image", () => {
  it("403s when the real-world surface is disabled (default OFF)", async () => {
    const { cookie } = await seed();
    const res = await app.inject({
      method: "POST",
      url: "/me/realworld/generate-image",
      cookies: { rid: cookie },
      payload: { prompt: "Launch banner" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a non-UUID draftRef with a clean 400 (never a DB 500)", async () => {
    const prev = process.env.RELOAD_REALWORLD_ENABLED;
    process.env.RELOAD_REALWORLD_ENABLED = "true";
    try {
      const { cookie } = await seed();
      const res = await app.inject({
        method: "POST",
        url: "/me/realworld/generate-image",
        cookies: { rid: cookie },
        payload: { prompt: "Banner", draftRef: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/draftRef must be a valid UUID/);
    } finally {
      if (prev === undefined) delete process.env.RELOAD_REALWORLD_ENABLED;
      else process.env.RELOAD_REALWORLD_ENABLED = prev;
    }
  });

  it("blocks generation until a brand kit exists, then attaches an on-brand image to a draft", async () => {
    const prev = process.env.RELOAD_REALWORLD_ENABLED;
    process.env.RELOAD_REALWORLD_ENABLED = "true"; // loadConfig reads env live
    try {
      const { cookie, workspaceId } = await seed();

      // No brand kit yet ⇒ Mark blocks it (400) and tells the owner to set the kit.
      const blocked = await app.inject({
        method: "POST",
        url: "/me/realworld/generate-image",
        cookies: { rid: cookie },
        payload: { prompt: "Launch banner", draftRef: newId() },
      });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error).toMatch(/brand kit/i);

      // Set the brand kit, then generate — now it succeeds and is stamped on-brand + draft-linked.
      await app.inject({
        method: "PUT",
        url: "/me/brand-kit",
        cookies: { rid: cookie },
        payload: { name: "Acme", palette: ["#1a73e8", "#34a853"], voice: "Confident." },
      });
      const draftRef = newId();
      const gen = await app.inject({
        method: "POST",
        url: "/me/realworld/generate-image",
        cookies: { rid: cookie },
        payload: { prompt: "Launch banner for the new release", draftRef },
      });
      expect(gen.statusCode).toBe(200);
      const body = gen.json();
      expect(body.status).toBe("generated");
      expect(body.asset.onBrand).toBe(true);
      expect(body.asset.sourceTool).toBe("generate_image");
      expect(body.asset.draftRef).toBe(draftRef);
      expect(body.asset.mime).toBe("image/svg+xml");
      expect(body.asset.brandKitId).toBeTruthy();

      // The asset is in the per-workspace store.
      const assets = await app.inject({ method: "GET", url: "/me/realworld/assets", cookies: { rid: cookie } });
      expect(assets.json().assets).toHaveLength(1);

      // ACCEPTANCE: the founder-console brand tile is now CONNECTED with the live asset count.
      const console = (
        await app.inject({
          method: "GET",
          url: `/workspaces/${workspaceId}/founder-console`,
          cookies: { rid: cookie },
        })
      ).json();
      const tile = brandTile(console);
      expect(tile.connection).toBe("connected");
      expect(tile.value).toBe(1);
      expect(tile.source).toMatch(/Brand kit/);
    } finally {
      if (prev === undefined) delete process.env.RELOAD_REALWORLD_ENABLED;
      else process.env.RELOAD_REALWORLD_ENABLED = prev;
    }
  });

  it("brand tile reads 'not connected' before any brand setup", async () => {
    const { cookie, workspaceId } = await seed();
    const console = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/founder-console`,
        cookies: { rid: cookie },
      })
    ).json();
    const tile = brandTile(console);
    expect(tile.connection).toBe("not_connected");
    expect(tile.display).toBe("not connected");
    expect(tile.source).toMatch(/Brand kit not set/);
  });
});
