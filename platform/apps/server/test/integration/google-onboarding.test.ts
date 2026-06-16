import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces, users } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import { listServiceStatuses } from "../../src/db/repositories/external-credentials.js";
import {
  setWorkspaceDomain,
  markWorkspaceBootstrapped,
} from "../../src/db/repositories/workspace-onboarding.js";
import type { GoogleOAuthClient } from "../../src/auth/google-client.js";
import type { OnboardingBootstrapInput } from "../../src/auth/onboarding-bootstrap.js";

const CONFIG = {
  clientId: "cid.apps.googleusercontent.com",
  clientSecret: "secret",
  redirectUri: "https://api.test/auth/google/callback",
};
const SECRET = "integration-state-secret";

let app: FastifyInstance;
const bootstrapCalls: OnboardingBootstrapInput[] = [];
let currentUser = { sub: "", email: "", emailVerified: true, name: "Founder" };
const currentTokens = {
  accessToken: "at",
  refreshToken: "rt",
  expiresInSec: 3600,
  scope: "openid email https://www.googleapis.com/auth/webmasters",
  tokenType: "Bearer",
};

const fakeClient: GoogleOAuthClient = {
  exchangeCode: async () => currentTokens,
  fetchUserInfo: async () => currentUser,
};

const createdWorkspaceIds: string[] = [];
const createdEmails: string[] = [];

beforeAll(async () => {
  app = buildApp({
    googleAuth: {
      config: CONFIG,
      client: fakeClient,
      stateSecret: SECRET,
      // Record the bootstrap and mimic the real one's durable mark so re-login doesn't re-fire it.
      bootstrap: async (input) => {
        bootstrapCalls.push(input);
        await setWorkspaceDomain(input.workspaceId, input.domain);
        await markWorkspaceBootstrapped(input.workspaceId);
      },
    },
  });
  await app.ready();
});

afterAll(async () => {
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  for (const email of createdEmails) {
    await db.delete(users).where(eq(users.email, email));
  }
  await app.close();
  await closeDb();
});

beforeEach(() => {
  bootstrapCalls.length = 0;
});

function stateFrom(location: string): string {
  return new URL(location).searchParams.get("state")!;
}

async function callback(code: string, state: string) {
  return app.inject({ method: "GET", url: `/auth/google/callback?code=${code}&state=${state}` });
}

describe("Google onboarding (#260, real Postgres)", () => {
  it("GET /auth/google/start redirects to Google's consent with identity + GSC + GA scopes", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/google/start?domain=https://www.Acme.com/" });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const scope = url.searchParams.get("scope")!;
    expect(scope).toContain("openid");
    expect(scope).toContain("https://www.googleapis.com/auth/webmasters");
    expect(scope).toContain("https://www.googleapis.com/auth/analytics.readonly");
    // The state carries the normalised domain (www stripped) for the callback.
    expect(url.searchParams.get("state")).toBeTruthy();
  });

  it("the callback creates the workspace, seals the Google connection, signs in, and bootstraps Scout", { timeout: 60000 }, async () => {
    const email = `founder-${newId()}@acme-${newId()}.com`;
    createdEmails.push(email);
    currentUser = { sub: `sub-${newId()}`, email, emailVerified: true, name: "Ada" };

    const start = await app.inject({ method: "GET", url: "/auth/google/start?domain=acme.com" });
    const cb = await callback("auth-code", stateFrom(start.headers.location as string));

    // Signed in + redirected to the board, with the rid session cookie set.
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/");
    const cookie = cb.cookies.find((c) => c.name === "rid");
    expect(cookie, "rid cookie set").toBeTruthy();

    // /me resolves the new human + workspace.
    const me = await app.inject({ method: "GET", url: "/me", cookies: { rid: cookie!.value } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ kind: "human", displayName: "Ada" });
    const workspaceId = me.json().workspaceId as string;
    createdWorkspaceIds.push(workspaceId);

    // The Google connection is stored under service_key `google` with the capability scopes (never a secret).
    const statuses = await listServiceStatuses(workspaceId);
    const google = statuses.find((s) => s.serviceKey === "google");
    expect(google?.connected).toBe(true);
    expect(google?.scopes).toEqual(expect.arrayContaining(["search_console", "analytics"]));

    // Scout was kicked to verify the domain + submit the sitemap.
    expect(bootstrapCalls).toHaveLength(1);
    expect(bootstrapCalls[0]).toMatchObject({ workspaceId, domain: "acme.com", siteUrl: "https://acme.com" });
  });

  it("a returning Google user re-enters the same workspace and is NOT re-bootstrapped", async () => {
    const email = `return-${newId()}@acme-${newId()}.com`;
    createdEmails.push(email);
    currentUser = { sub: `sub-${newId()}`, email, emailVerified: true, name: "Grace" };

    const first = await callback(
      "code1",
      stateFrom((await app.inject({ method: "GET", url: "/auth/google/start?domain=acme.com" })).headers
        .location as string),
    );
    const me1 = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { rid: first.cookies.find((c) => c.name === "rid")!.value },
    });
    const workspaceId = me1.json().workspaceId as string;
    createdWorkspaceIds.push(workspaceId);
    expect(bootstrapCalls).toHaveLength(1);

    bootstrapCalls.length = 0;
    const second = await callback(
      "code2",
      stateFrom((await app.inject({ method: "GET", url: "/auth/google/start?domain=acme.com" })).headers
        .location as string),
    );
    const me2 = await app.inject({
      method: "GET",
      url: "/me",
      cookies: { rid: second.cookies.find((c) => c.name === "rid")!.value },
    });
    expect(me2.json().workspaceId).toBe(workspaceId); // same workspace, keyed by verified email
    expect(bootstrapCalls).toHaveLength(0); // already bootstrapped — Scout is not re-briefed every login
  });

  it("rejects a tampered/forged state with a friendly redirect (no account created)", async () => {
    currentUser = { sub: "x", email: `nope-${newId()}@e.com`, emailVerified: true, name: "X" };
    const res = await callback("code", "forged.state");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/start?error=bad_state");
    expect(bootstrapCalls).toHaveLength(0);
  });

  it("rejects an unverified Google email", async () => {
    currentUser = { sub: "y", email: `unverified-${newId()}@e.com`, emailVerified: false, name: "Y" };
    const start = await app.inject({ method: "GET", url: "/auth/google/start?domain=acme.com" });
    const res = await callback("code", stateFrom(start.headers.location as string));
    expect(res.headers.location).toBe("/start?error=email_unverified");
  });

  it("redirects an invalid domain back to the onboarding screen", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/google/start?domain=not-a-domain" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/start?error=invalid_domain");
  });

  it("when Google is not configured, the flow degrades honestly", async () => {
    const off = buildApp({ googleAuth: { config: null } });
    await off.ready();
    try {
      const res = await off.inject({ method: "GET", url: "/auth/google/start?domain=acme.com" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/start?error=google_unavailable");
    } finally {
      await off.close();
    }
  });
});
