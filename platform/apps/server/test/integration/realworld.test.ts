import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { createDefaultRealworldActuatorService } from "../../src/realworld/default.js";
import { listArtifacts } from "../../src/db/repositories/realworld-artifacts.js";

/**
 * #231 — the real-world tool surface + the fixed readiness signal, end-to-end on a real Postgres.
 *
 * Proves the two acceptance facts the issue calls out:
 *  - `founder-console.setup.connected` reflects reality: it reads 0 with nothing connected and >=1 once
 *    Claude is connected (the bug was that "Connect Claude" writes a different vault than the pane read).
 *  - The fleet has a gated, account-aware real-world surface: `/me/realworld` reports per-tool gate
 *    decisions + exactly what to connect, and a publish with no hosting account is BLOCKED + recorded.
 */
const app = buildApp();
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await app.close();
  await Promise.allSettled([closeDb(), closeRedis()]);
});

async function seed(): Promise<{ cookie: string; workspaceId: string; memberId: string }> {
  const slug = `rw-${newId()}`;
  slugs.push(slug);
  const signup = await app.inject({
    method: "POST",
    url: "/auth/signup",
    payload: { email: `u-${newId()}@e.com`, password: "pw", displayName: "U", workspaceSlug: slug },
  });
  const cookie = signup.cookies.find((c) => c.name === "rid")!.value;
  const me = (await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie } })).json();
  return { cookie, workspaceId: me.workspaceId, memberId: me.memberId };
}

describe("readiness signal (#231) — setup.connected reflects Claude", () => {
  it("reads 0 with nothing connected, then >=1 after Connect Claude", async () => {
    const { cookie, workspaceId } = await seed();

    const before = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/founder-console`,
        cookies: { rid: cookie },
      })
    ).json();
    expect(before.setup.connected).toBe(0);

    // Connect Claude (#68) — writes workspace_agent_credentials, the vault the pane previously ignored.
    const put = await app.inject({
      method: "PUT",
      url: "/me/agent-credentials",
      cookies: { rid: cookie },
      payload: { token: "sk-ant-oat-readiness" },
    });
    expect(put.statusCode).toBe(200);

    const after = (
      await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceId}/founder-console`,
        cookies: { rid: cookie },
      })
    ).json();
    expect(after.setup.connected).toBeGreaterThanOrEqual(1);
  });
});

describe("real-world tool surface (#231) — /me/realworld", () => {
  it("reports the seven tools, what to connect, and the published-artifacts feed", async () => {
    const { cookie } = await seed();
    const res = await app.inject({ method: "GET", url: "/me/realworld", cookies: { rid: cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false); // default OFF
    expect(body.availability).toHaveLength(7);
    // With nothing connected the owner must still connect the real-work accounts.
    expect(body.neededAccounts.sort()).toEqual(["ad_account", "esp", "hosting", "registrar"].sort());
    expect(body.artifacts).toEqual([]);
  });
});

describe("real-world actuator (#231) — publish is gated + recorded", () => {
  it("BLOCKS publish without a hosting account and writes a durable receipt", async () => {
    const { workspaceId, memberId } = await seed();
    const svc = createDefaultRealworldActuatorService(); // dry-run publisher, real repos
    const out = await svc.publishPage({
      workspaceId,
      slug: `canary-${newId()}`,
      html: "<h1>hi</h1>",
      requesterMemberId: memberId,
    });
    expect(out.status).toBe("blocked");
    const artifacts = await listArtifacts(workspaceId);
    expect(artifacts[0]).toMatchObject({ tool: "publish", status: "blocked", url: null });
  });
});
