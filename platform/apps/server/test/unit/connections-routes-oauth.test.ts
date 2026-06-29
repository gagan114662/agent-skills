import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";
import { CONNECTION_CONNECT_ACCOUNT_ACTION } from "../../src/approvals/policy.js";
import { signConnectState } from "../../src/connections/state.js";

const OWNER = "ws-owner";
const MEMBER = "member-owner";
const STATE_SECRET = "test-state-secret";
const ORIGINAL_ENC_KEY = process.env.AGENT_CREDENTIALS_ENC_KEY;
const ORIGINAL_LINKEDIN_CLIENT_ID = process.env.LINKEDIN_OAUTH_CLIENT_ID;
const ORIGINAL_LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_OAUTH_CLIENT_SECRET;

const defaultConnectProvider = vi.fn();
const googleConnectionOAuthConfigStatus = vi.fn();
const googleAdsConnectionOAuthConfigStatus = vi.fn();
const linkedInConnectionOAuthConfigStatus = vi.fn();
const metaAdsConnectionOAuthConfigStatus = vi.fn();
const xConnectionOAuthConfigStatus = vi.fn();
const getRequest = vi.fn();
const recordExecution = vi.fn();
const listServiceStatuses = vi.fn();
const setServiceCredentials = vi.fn();
const revokeServiceCredentials = vi.fn();
const connectChannel = vi.fn();
const revokeChannel = vi.fn();
const loadConfig = vi.fn();

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: OWNER, memberId: MEMBER })),
}));

vi.mock("../../src/config/loader.js", () => ({ loadConfig }));

vi.mock("../../src/connections/default.js", () => ({
  defaultConnectProvider,
  googleAdsConnectionOAuthConfigStatus,
  googleConnectionOAuthConfigStatus,
  linkedInConnectionOAuthConfigStatus,
  metaAdsConnectionOAuthConfigStatus,
  xConnectionOAuthConfigStatus,
  createDefaultConnectOnceService: vi.fn(() => ({
    startConnect: vi.fn(async () => ({ status: "coming_soon", reason: "not under test" })),
  })),
}));

vi.mock("../../src/db/repositories/approvals.js", () => ({
  getRequest,
  recordExecution,
}));

vi.mock("../../src/db/repositories/external-credentials.js", () => ({
  listServiceStatuses,
  setServiceCredentials,
  revokeServiceCredentials,
}));

vi.mock("../../src/outbound-channel/service.js", () => ({
  connectChannel,
  revokeChannel,
}));

const { connectionsRoutes } = await import("../../src/routes/connections.js");

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = new Date("2026-06-27T00:00:00Z");
  return {
    id: "req-1",
    workspaceId: OWNER,
    requesterMemberId: MEMBER,
    actionType: CONNECTION_CONNECT_ACCOUNT_ACTION,
    payload: { connectionId: "google", provider: "google" },
    amount: null,
    summary: "Connect Google",
    status: "approved",
    reason: null,
    decidedByMemberId: MEMBER,
    decidedAt: now,
    expiresAt: null,
    expiresAtTimezone: "UTC",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function buildRoute() {
  const app = Fastify();
  await app.register(connectionsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        scope:
          "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/analytics.readonly",
        sub: "google-sub-1",
        aud: "google-client-id",
      }),
    })),
  );
  process.env.AGENT_CREDENTIALS_ENC_KEY = STATE_SECRET;
  process.env.RESEND_API_KEY = "";
  process.env.RELOAD_FLEET_FROM_EMAIL = "";
  loadConfig.mockReturnValue({ marketing: { ownerWorkspaceId: OWNER }, connectOnce: undefined });
  listServiceStatuses.mockResolvedValue([]);
  getRequest.mockResolvedValue(approval());
  recordExecution.mockResolvedValue({ outcome: "recorded", request: approval({ status: "executed" }) });
  connectChannel.mockResolvedValue({ ok: true, connection: { id: "conn-1" } });
  revokeChannel.mockResolvedValue({ id: "conn-1" });
  setServiceCredentials.mockResolvedValue({
    serviceKey: "google",
    connected: true,
    status: "connected",
    fingerprint: "fp_google",
    envKeys: ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_SCOPE"],
    scopes: ["search_console", "analytics"],
    rotationReminderDays: null,
    connectedAtMs: Date.now(),
    revokedAtMs: null,
  });
  googleConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["GOOGLE_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/google/oauth/callback",
  });
  googleAdsConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/google_ads/oauth/callback",
  });
  linkedInConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/linkedin/oauth/callback",
  });
  metaAdsConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["META_ADS_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/meta_ads/oauth/callback",
  });
  xConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["X_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/x/oauth/callback",
  });
});

describe("connectionsRoutes OAuth descriptor availability (#1285)", () => {
  it("marks every wired OAuth provider available on the customer connections surface", async () => {
    const liveIds = new Set(["google", "x", "google_ads", "meta_ads", "linkedin"]);
    defaultConnectProvider.mockImplementation((id: string) => ({
      live: liveIds.has(id),
      authorizeUrl: vi.fn(),
      exchange: vi.fn(),
    }));

    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/me/connections",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        connections: Array<{ id: string; status: string; configIssue?: unknown }>;
      };
      for (const id of liveIds) {
        const connection = body.connections.find((item) => item.id === id);
        expect(connection).toMatchObject({ id, status: "available" });
        expect(connection?.configIssue ?? null).toBeNull();
      }
    } finally {
      await app.close();
    }
  });

  it("keeps an unwired OAuth provider honest with missing-config setup details", async () => {
    defaultConnectProvider.mockReturnValue({
      live: false,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(),
    });

    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/me/connections",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        connections: Array<{
          id: string;
          status: string;
          configIssue?: { code: string; missingEnv: string[] };
        }>;
      };
      expect(body.connections.find((item) => item.id === "google")).toMatchObject({
        status: "coming_soon",
        configIssue: {
          code: "google_connection_oauth_missing_config",
          missingEnv: ["GOOGLE_CONNECTION_OAUTH_REDIRECT_URI"],
        },
      });
    } finally {
      await app.close();
    }
  });
});

describe("connectionsRoutes one-click email provider proof (#395)", () => {
  it("seals Resend proof and connects the matching outbound-channel ledger on enable", async () => {
    process.env.RESEND_API_KEY = "re-secret";
    process.env.RELOAD_FLEET_FROM_EMAIL = "hello@ipop.ai";
    loadConfig.mockReturnValue({
      marketing: { ownerWorkspaceId: OWNER },
      connectOnce: undefined,
      reach: { sendProvider: "resend", liveSendEnabled: true },
    });
    listServiceStatuses.mockResolvedValue([
      {
        serviceKey: "resend",
        status: "connected",
        envKeys: ["RESEND_API_KEY", "RESEND_FROM"],
        fingerprint: "fp_resend",
        connectedAtMs: 123,
      },
    ]);

    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/me/connections/email/enable",
      });

      expect(res.statusCode).toBe(200);
      expect(connectChannel).toHaveBeenCalledWith({
        workspaceId: OWNER,
        channel: "email_resend",
        fromAddress: "hello@ipop.ai",
        connectedByMemberId: MEMBER,
      });
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "resend",
        secrets: {
          RESEND_API_KEY: "re-secret",
          RESEND_FROM: "hello@ipop.ai",
        },
        scopes: ["send_email"],
        connectedByMemberId: MEMBER,
      });
      expect(res.json()).toMatchObject({
        connected: true,
        id: "email",
        providerStatus: "healthy",
      });
    } finally {
      await app.close();
    }
  });
});

describe("connectionsRoutes X OAuth callback (#1285)", () => {
  it("exchanges an approved X callback, verifies /2/users/me, seals, and records non-secret proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: { id: "x-user-1", username: "ipop_ai" } }),
      })),
    );
    const exchange = vi.fn(async () => ({
      capabilities: ["post_social"],
      secrets: {
        X_OAUTH_ACCESS_TOKEN: "x-access-token",
        X_OAUTH_SCOPE: "tweet.read tweet.write users.read offline.access",
      },
    }));
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange,
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "x", provider: "x" },
        summary: "Connect X",
      }),
    );
    setServiceCredentials.mockResolvedValue({
      serviceKey: "x",
      connected: true,
      status: "connected",
      fingerprint: "fp_x",
      envKeys: ["X_OAUTH_ACCESS_TOKEN", "X_OAUTH_SCOPE"],
      scopes: ["post_social"],
      rotationReminderDays: null,
      connectedAtMs: Date.now(),
      revokedAtMs: null,
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "x", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/x/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=x&status=connected");
      expect(fetch).toHaveBeenCalledWith("https://api.x.com/2/users/me", {
        method: "GET",
        headers: { authorization: "Bearer x-access-token" },
      });
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "x",
        secrets: {
          X_OAUTH_ACCESS_TOKEN: "x-access-token",
          X_OAUTH_SCOPE: "tweet.read tweet.write users.read offline.access",
        },
        scopes: ["post_social"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "x",
          provider: "x",
          envKeys: ["X_OAUTH_ACCESS_TOKEN", "X_OAUTH_SCOPE"],
          fingerprint: "fp_x",
          scopes: ["post_social"],
          health: {
            provider: "x",
            checkedAtMs: expect.any(Number),
            scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
            subject: "x-user-1",
            audience: "ipop_ai",
          },
        },
      });
      expect(String(res.headers.location)).not.toContain("x-access-token");
    } finally {
      await app.close();
    }
  });

  it("refuses to seal X when the token lacks the posting scope", async () => {
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(async () => ({
        capabilities: [],
        secrets: {
          X_OAUTH_ACCESS_TOKEN: "x-access-token",
          X_OAUTH_SCOPE: "tweet.read users.read offline.access",
        },
      })),
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "x", provider: "x" },
        summary: "Connect X",
      }),
    );
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "x", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/x/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=x&status=error");
      expect(setServiceCredentials).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: false,
        error: "X token is missing required scopes: tweet.write",
      });
    } finally {
      await app.close();
    }
  });
});

describe("connectionsRoutes Google Ads OAuth callback (#1285)", () => {
  it("exchanges an approved Google Ads callback, verifies tokeninfo scope, seals, and records proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          scope: "https://www.googleapis.com/auth/adwords",
          sub: "google-ads-sub-1",
          aud: "google-client-id",
        }),
      })),
    );
    const exchange = vi.fn(async () => ({
      capabilities: ["ads"],
      secrets: {
        GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "ads-access-token",
        GOOGLE_ADS_OAUTH_SCOPE: "https://www.googleapis.com/auth/adwords",
      },
    }));
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange,
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "google_ads", provider: "google" },
        summary: "Connect Google Ads",
      }),
    );
    setServiceCredentials.mockResolvedValue({
      serviceKey: "google_ads",
      connected: true,
      status: "connected",
      fingerprint: "fp_google_ads",
      envKeys: ["GOOGLE_ADS_OAUTH_ACCESS_TOKEN", "GOOGLE_ADS_OAUTH_SCOPE"],
      scopes: ["ads"],
      rotationReminderDays: null,
      connectedAtMs: Date.now(),
      revokedAtMs: null,
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google_ads", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/google_ads/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=google_ads&status=connected");
      expect(fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: expect.stringContaining("https://oauth2.googleapis.com/tokeninfo?"),
        }),
        { method: "GET" },
      );
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "google_ads",
        secrets: {
          GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "ads-access-token",
          GOOGLE_ADS_OAUTH_SCOPE: "https://www.googleapis.com/auth/adwords",
        },
        scopes: ["ads"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "google_ads",
          provider: "google",
          envKeys: ["GOOGLE_ADS_OAUTH_ACCESS_TOKEN", "GOOGLE_ADS_OAUTH_SCOPE"],
          fingerprint: "fp_google_ads",
          scopes: ["ads"],
          health: {
            provider: "google",
            checkedAtMs: expect.any(Number),
            scopes: ["https://www.googleapis.com/auth/adwords"],
            subject: "google-ads-sub-1",
            audience: "google-client-id",
          },
        },
      });
      expect(String(res.headers.location)).not.toContain("ads-access-token");
    } finally {
      await app.close();
    }
  });

  it("refuses to seal Google Ads when tokeninfo lacks the adwords scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ scope: "openid email profile" }),
      })),
    );
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(async () => ({
        capabilities: ["ads"],
        secrets: {
          GOOGLE_ADS_OAUTH_ACCESS_TOKEN: "ads-access-token",
          GOOGLE_ADS_OAUTH_SCOPE: "https://www.googleapis.com/auth/adwords",
        },
      })),
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "google_ads", provider: "google" },
        summary: "Connect Google Ads",
      }),
    );
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google_ads", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/google_ads/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=google_ads&status=error");
      expect(setServiceCredentials).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: false,
        error:
          "Google Ads token is missing required scopes: https://www.googleapis.com/auth/adwords",
      });
    } finally {
      await app.close();
    }
  });
});

describe("connectionsRoutes Meta Ads OAuth callback (#1285)", () => {
  it("exchanges an approved Meta Ads callback, verifies permissions and identity, seals, and records proof", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { permission: "ads_read", status: "granted" },
              { permission: "ads_management", status: "granted" },
              { permission: "business_management", status: "granted" },
            ],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: "meta-user-1", name: "Ipop Operator" }),
        }),
    );
    const exchange = vi.fn(async () => ({
      capabilities: ["ads"],
      secrets: {
        META_ADS_OAUTH_ACCESS_TOKEN: "meta-access-token",
        META_ADS_OAUTH_SCOPE: "ads_read ads_management business_management",
      },
    }));
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange,
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "meta_ads", provider: "meta" },
        summary: "Connect Meta Ads",
      }),
    );
    setServiceCredentials.mockResolvedValue({
      serviceKey: "meta_ads",
      connected: true,
      status: "connected",
      fingerprint: "fp_meta_ads",
      envKeys: ["META_ADS_OAUTH_ACCESS_TOKEN", "META_ADS_OAUTH_SCOPE"],
      scopes: ["ads"],
      rotationReminderDays: null,
      connectedAtMs: Date.now(),
      revokedAtMs: null,
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "meta_ads", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/meta_ads/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=meta_ads&status=connected");
      const fetchCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
      expect(String(fetchCalls[0][0])).toContain("https://graph.facebook.com/v21.0/me/permissions?");
      expect(fetchCalls[0][1]).toEqual({ method: "GET" });
      expect(String(fetchCalls[1][0])).toContain("https://graph.facebook.com/v21.0/me?");
      expect(fetchCalls[1][1]).toEqual({ method: "GET" });
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "meta_ads",
        secrets: {
          META_ADS_OAUTH_ACCESS_TOKEN: "meta-access-token",
          META_ADS_OAUTH_SCOPE: "ads_read ads_management business_management",
        },
        scopes: ["ads"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "meta_ads",
          provider: "meta",
          envKeys: ["META_ADS_OAUTH_ACCESS_TOKEN", "META_ADS_OAUTH_SCOPE"],
          fingerprint: "fp_meta_ads",
          scopes: ["ads"],
          health: {
            provider: "meta",
            checkedAtMs: expect.any(Number),
            scopes: ["ads_read", "ads_management", "business_management"],
            subject: "meta-user-1",
            audience: "Ipop Operator",
          },
        },
      });
      expect(String(res.headers.location)).not.toContain("meta-access-token");
    } finally {
      await app.close();
    }
  });

  it("refuses to seal Meta Ads when a required permission is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { permission: "ads_read", status: "granted" },
            { permission: "ads_management", status: "declined" },
          ],
        }),
      })),
    );
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(async () => ({
        capabilities: ["ads"],
        secrets: {
          META_ADS_OAUTH_ACCESS_TOKEN: "meta-access-token",
          META_ADS_OAUTH_SCOPE: "ads_read ads_management business_management",
        },
      })),
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "meta_ads", provider: "meta" },
        summary: "Connect Meta Ads",
      }),
    );
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "meta_ads", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/meta_ads/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=meta_ads&status=error");
      expect(setServiceCredentials).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: false,
        error:
          "Meta Ads token is missing required permissions: ads_management, business_management",
      });
    } finally {
      await app.close();
    }
  });
});

describe("connectionsRoutes LinkedIn OAuth callback (#1285)", () => {
  it("exchanges an approved LinkedIn callback, introspects token scopes, seals, and records proof", async () => {
    process.env.LINKEDIN_OAUTH_CLIENT_ID = "linkedin-client";
    process.env.LINKEDIN_OAUTH_CLIENT_SECRET = "linkedin-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          active: true,
          status: "active",
          scope: "w_member_social",
          client_id: "linkedin-client",
          auth_type: "3L",
        }),
      })),
    );
    const exchange = vi.fn(async () => ({
      capabilities: ["post_social"],
      secrets: {
        LINKEDIN_OAUTH_ACCESS_TOKEN: "linkedin-access-token",
        LINKEDIN_OAUTH_SCOPE: "w_member_social",
      },
    }));
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange,
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "linkedin", provider: "linkedin" },
        summary: "Connect LinkedIn",
      }),
    );
    setServiceCredentials.mockResolvedValue({
      serviceKey: "linkedin",
      connected: true,
      status: "connected",
      fingerprint: "fp_linkedin",
      envKeys: ["LINKEDIN_OAUTH_ACCESS_TOKEN", "LINKEDIN_OAUTH_SCOPE"],
      scopes: ["post_social"],
      rotationReminderDays: null,
      connectedAtMs: Date.now(),
      revokedAtMs: null,
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "linkedin", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/linkedin/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=linkedin&status=connected");
      expect(fetch).toHaveBeenCalledWith("https://www.linkedin.com/oauth/v2/introspectToken", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: expect.any(URLSearchParams),
      });
      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as URLSearchParams;
      expect(body.get("client_id")).toBe("linkedin-client");
      expect(body.get("client_secret")).toBe("linkedin-secret");
      expect(body.get("token")).toBe("linkedin-access-token");
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "linkedin",
        secrets: {
          LINKEDIN_OAUTH_ACCESS_TOKEN: "linkedin-access-token",
          LINKEDIN_OAUTH_SCOPE: "w_member_social",
        },
        scopes: ["post_social"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "linkedin",
          provider: "linkedin",
          envKeys: ["LINKEDIN_OAUTH_ACCESS_TOKEN", "LINKEDIN_OAUTH_SCOPE"],
          fingerprint: "fp_linkedin",
          scopes: ["post_social"],
          health: {
            provider: "linkedin",
            checkedAtMs: expect.any(Number),
            scopes: ["w_member_social"],
            subject: "3L",
            audience: "linkedin-client",
          },
        },
      });
      expect(String(res.headers.location)).not.toContain("linkedin-access-token");
    } finally {
      await app.close();
    }
  });

  it("refuses to seal LinkedIn when token introspection lacks w_member_social", async () => {
    process.env.LINKEDIN_OAUTH_CLIENT_ID = "linkedin-client";
    process.env.LINKEDIN_OAUTH_CLIENT_SECRET = "linkedin-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          active: true,
          status: "active",
          scope: "r_liteprofile",
          client_id: "linkedin-client",
          auth_type: "3L",
        }),
      })),
    );
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(async () => ({
        capabilities: ["post_social"],
        secrets: {
          LINKEDIN_OAUTH_ACCESS_TOKEN: "linkedin-access-token",
          LINKEDIN_OAUTH_SCOPE: "w_member_social",
        },
      })),
    });
    getRequest.mockResolvedValue(
      approval({
        payload: { connectionId: "linkedin", provider: "linkedin" },
        summary: "Connect LinkedIn",
      }),
    );
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "linkedin", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/linkedin/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=linkedin&status=error");
      expect(setServiceCredentials).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: false,
        error: "LinkedIn token is missing required scopes: w_member_social",
      });
    } finally {
      await app.close();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_ENC_KEY === undefined) {
    delete process.env.AGENT_CREDENTIALS_ENC_KEY;
  } else {
    process.env.AGENT_CREDENTIALS_ENC_KEY = ORIGINAL_ENC_KEY;
  }
  if (ORIGINAL_LINKEDIN_CLIENT_ID === undefined) {
    delete process.env.LINKEDIN_OAUTH_CLIENT_ID;
  } else {
    process.env.LINKEDIN_OAUTH_CLIENT_ID = ORIGINAL_LINKEDIN_CLIENT_ID;
  }
  if (ORIGINAL_LINKEDIN_CLIENT_SECRET === undefined) {
    delete process.env.LINKEDIN_OAUTH_CLIENT_SECRET;
  } else {
    process.env.LINKEDIN_OAUTH_CLIENT_SECRET = ORIGINAL_LINKEDIN_CLIENT_SECRET;
  }
});

describe("connectionsRoutes OAuth callback (#1285)", () => {
  it("fails closed when the Google provider is not live", async () => {
    defaultConnectProvider.mockReturnValue({
      live: false,
      authorizeUrl: vi.fn(() => "about:blank"),
      exchange: vi.fn(),
    });
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/me/connections/google/oauth/authorize?requestId=req-1",
      });
      expect(res.statusCode).toBe(501);
      expect(res.json()).toMatchObject({
        status: "coming_soon",
        provider: "google",
        issue: {
          code: "google_connection_oauth_missing_config",
          missingEnv: ["GOOGLE_CONNECTION_OAUTH_REDIRECT_URI"],
          callbackPath: "/me/connections/google/oauth/callback",
        },
      });
      expect(getRequest).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("redirects an approved request to the provider with state bound to the approval id", async () => {
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(({ state }: { state: string }) => `https://accounts.example/auth?state=${encodeURIComponent(state)}`),
      exchange: vi.fn(),
    });
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/me/connections/google/oauth/authorize?requestId=req-1",
      });
      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(location).toMatch(/^https:\/\/accounts\.example\/auth\?/);
      const state = new URL(location as string).searchParams.get("state");
      expect(state).toContain(".");
    } finally {
      await app.close();
    }
  });

  it("exchanges a valid callback, verifies provider health, seals the credential, and records non-secret proof", async () => {
    const exchange = vi.fn(async () => ({
      capabilities: ["search_console", "analytics"],
      secrets: {
        GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
        GOOGLE_OAUTH_SCOPE:
          "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/analytics.readonly",
      },
    }));
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange,
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/google/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=google&status=connected");
      expect(exchange).toHaveBeenCalledWith({ code: "auth-code-1", state });
      expect(fetch).toHaveBeenCalledWith(
        expect.objectContaining({
          href: expect.stringContaining("https://oauth2.googleapis.com/tokeninfo?"),
        }),
        { method: "GET" },
      );
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "google",
        secrets: {
          GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
          GOOGLE_OAUTH_SCOPE:
            "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/analytics.readonly",
        },
        scopes: ["search_console", "analytics"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "google",
          provider: "google",
          envKeys: ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_SCOPE"],
          fingerprint: "fp_google",
          scopes: ["search_console", "analytics"],
          health: {
            provider: "google",
            checkedAtMs: expect.any(Number),
            scopes: [
              "https://www.googleapis.com/auth/webmasters",
              "https://www.googleapis.com/auth/analytics.readonly",
            ],
            subject: "google-sub-1",
            audience: "google-client-id",
          },
        },
      });
      expect(String(res.headers.location)).not.toContain("access-token");
    } finally {
      await app.close();
    }
  });

  it("refuses to seal the credential when provider health proof fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ scope: "https://www.googleapis.com/auth/webmasters" }),
      })),
    );
    defaultConnectProvider.mockReturnValue({
      live: true,
      authorizeUrl: vi.fn(),
      exchange: vi.fn(async () => ({
        capabilities: ["search_console", "analytics"],
        secrets: {
          GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
          GOOGLE_OAUTH_SCOPE:
            "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/analytics.readonly",
        },
      })),
    });
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", approvalRequestId: "req-1", nonce: "n1" },
      STATE_SECRET,
    );
    const app = await buildRoute();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/me/connections/google/oauth/callback?code=auth-code-1&state=${encodeURIComponent(state)}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/everyday?connection=google&status=error");
      expect(setServiceCredentials).not.toHaveBeenCalled();
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: false,
        error:
          "Google token is missing required scopes: https://www.googleapis.com/auth/analytics.readonly",
      });
    } finally {
      await app.close();
    }
  });
});
