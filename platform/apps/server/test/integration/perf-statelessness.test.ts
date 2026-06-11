import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";

/**
 * Statelessness proof (#113, ADR-0113 §5). Two SEPARATE app instances over the same Postgres/Redis: a
 * session created on instance A must authenticate on instance B. If it does, there is no in-memory
 * session affinity — any replica can serve any request, the precondition for horizontal scale-out.
 */

const instanceA = buildApp();
const instanceB = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await instanceA.close();
  await instanceB.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

describe("server is stateless (no in-memory session affinity)", () => {
  it("authenticates on instance B a session minted on instance A", async () => {
    const slug = `stateless-${newId()}`;
    slugs.push(slug);

    // Mint a session on instance A.
    const signup = await instanceA.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
    });
    expect(signup.statusCode).toBe(201);
    const cookie = signup.cookies.find((c) => c.name === "rid")!.value;

    // The SAME cookie must work against a DIFFERENT instance (session state lives in Postgres, not memory).
    const meOnB = await instanceB.inject({ method: "GET", url: "/me", cookies: { rid: cookie } });
    expect(meOnB.statusCode).toBe(200);
    const meOnA = await instanceA.inject({ method: "GET", url: "/me", cookies: { rid: cookie } });
    expect(meOnB.json().memberId).toBe(meOnA.json().memberId);
    expect(meOnB.json().workspaceId).toBe(meOnA.json().workspaceId);
  });

  it("rejects an unknown session on both instances identically (no per-instance trust)", async () => {
    const a = await instanceA.inject({ method: "GET", url: "/me", cookies: { rid: "not-a-real-session" } });
    const b = await instanceB.inject({ method: "GET", url: "/me", cookies: { rid: "not-a-real-session" } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
  });
});
