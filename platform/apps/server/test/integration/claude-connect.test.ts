import { describe, it, expect, afterAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { closeRedis } from "../../src/redis/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { getCredentialStatus } from "../../src/db/repositories/agent-credentials.js";
import { DryRunClaudeConnectProvider, LiveClaudeConnectProvider } from "../../src/auth/claude-connect.js";

/**
 * #262 — Connect Claude without a CLI token, end-to-end on a real Postgres.
 *
 * Proves the acceptance: a user enables the agents WITHOUT a terminal or a pasted token. The default
 * deployment features today's paste path; the owner workspace, once opted in with a live OAuth client,
 * gets the one-click flow whose callback seals the subscription token into the #68 vault — and the flow
 * refuses a cross-tenant or poisoned callback (premortem #200 §6).
 */
const slugs: string[] = [];

afterAll(async () => {
  for (const slug of slugs) await db.delete(workspaces).where(eq(workspaces.slug, slug));
  await Promise.allSettled([closeDb(), closeRedis()]);
});

afterEach(() => {
  delete process.env.RELOAD_CONNECT_CLAUDE_ENABLED;
  delete process.env.RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID;
});

async function seed(app: ReturnType<typeof buildApp>): Promise<{ cookie: string; workspaceId: string }> {
  const slug = `cc-${newId()}`;
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

describe("claude-connect (#262) — default deployment keeps the manual paste path", () => {
  it("offers paste_token and refuses to start the managed flow when not enabled", async () => {
    const app = buildApp();
    try {
      const { cookie } = await seed(app);
      const offer = (
        await app.inject({ method: "GET", url: "/me/claude/connect", cookies: { rid: cookie } })
      ).json();
      expect(offer.offer.method).toBe("paste_token");
      expect(offer.offer.managed).toBe(false);

      const start = await app.inject({
        method: "POST",
        url: "/me/claude/connect/start",
        cookies: { rid: cookie },
      });
      expect(start.statusCode).toBe(409); // managed connect isn't enabled for this workspace
    } finally {
      await app.close();
    }
  });

  it("requires auth (401 without a session)", async () => {
    const app = buildApp();
    try {
      const res = await app.inject({ method: "GET", url: "/me/claude/connect" });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

describe("claude-connect (#262) — owner workspace, managed flow enabled", () => {
  it("features coming_soon while no live OAuth client is wired (honest, never fake-connected)", async () => {
    const app = buildApp({ claudeConnect: { provider: new DryRunClaudeConnectProvider() } });
    try {
      const { cookie, workspaceId } = await seed(app);
      process.env.RELOAD_CONNECT_CLAUDE_ENABLED = "true";
      process.env.RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID = workspaceId;

      const offer = (
        await app.inject({ method: "GET", url: "/me/claude/connect", cookies: { rid: cookie } })
      ).json();
      expect(offer.offer.method).toBe("managed_oauth");
      expect(offer.offer.status).toBe("coming_soon");

      const start = await app.inject({
        method: "POST",
        url: "/me/claude/connect/start",
        cookies: { rid: cookie },
      });
      expect(start.statusCode).toBe(501); // featured but not wired
    } finally {
      await app.close();
    }
  });

  it("with a live provider: start returns an authorize URL and the callback seals the token into the #68 vault", async () => {
    const cfg = {
      clientId: "client-123",
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      redirectUri: "https://app.test/me/claude/connect/callback",
    };
    // A live provider whose exchange returns a token without touching the network.
    class FakeLive extends LiveClaudeConnectProvider {
      override async exchange(): Promise<{ token: string | null }> {
        return { token: "sk-ant-oat-from-oauth" };
      }
    }
    const app = buildApp({ claudeConnect: { provider: new FakeLive(cfg) } });
    try {
      const { cookie, workspaceId } = await seed(app);
      process.env.RELOAD_CONNECT_CLAUDE_ENABLED = "true";
      process.env.RELOAD_CONNECT_CLAUDE_OWNER_WORKSPACE_ID = workspaceId;

      const offer = (
        await app.inject({ method: "GET", url: "/me/claude/connect", cookies: { rid: cookie } })
      ).json();
      expect(offer.offer.status).toBe("available");

      const start = await app.inject({
        method: "POST",
        url: "/me/claude/connect/start",
        cookies: { rid: cookie },
      });
      expect(start.statusCode).toBe(200);
      const authorizeUrl = new URL(start.json().authorizeUrl);
      const state = authorizeUrl.searchParams.get("state")!;
      expect(state).toBeTruthy();

      // Not connected yet.
      expect((await getCredentialStatus(workspaceId)).connected).toBe(false);

      // A poisoned code is rejected (no token sealed) — injection defense.
      const poisoned = await app.inject({
        method: "GET",
        url: `/me/claude/connect/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent("../etc&x=1")}`,
        cookies: { rid: cookie },
      });
      expect(poisoned.headers.location).toBe("/?claude=error");
      expect((await getCredentialStatus(workspaceId)).connected).toBe(false);

      // The real callback seals the token and redirects connected.
      const cb = await app.inject({
        method: "GET",
        url: `/me/claude/connect/callback?state=${encodeURIComponent(state)}&code=ac_validcode123`,
        cookies: { rid: cookie },
      });
      expect(cb.headers.location).toBe("/?claude=connected");
      const status = await getCredentialStatus(workspaceId);
      expect(status.connected).toBe(true);
      expect(status.fingerprint).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
