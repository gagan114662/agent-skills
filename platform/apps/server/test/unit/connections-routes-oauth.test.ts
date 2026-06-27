import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";
import { CONNECTION_CONNECT_ACCOUNT_ACTION } from "../../src/approvals/policy.js";
import { signConnectState } from "../../src/connections/state.js";

const OWNER = "ws-owner";
const MEMBER = "member-owner";
const STATE_SECRET = "test-state-secret";
const ORIGINAL_ENC_KEY = process.env.AGENT_CREDENTIALS_ENC_KEY;

const defaultConnectProvider = vi.fn();
const googleConnectionOAuthConfigStatus = vi.fn();
const getRequest = vi.fn();
const recordExecution = vi.fn();
const setServiceCredentials = vi.fn();

vi.mock("../../src/auth/guard.js", () => ({
  requireIdentity: vi.fn(async () => ({ workspaceId: OWNER, memberId: MEMBER })),
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn(() => ({ marketing: { ownerWorkspaceId: OWNER }, connectOnce: undefined })),
}));

vi.mock("../../src/connections/default.js", () => ({
  defaultConnectProvider,
  googleConnectionOAuthConfigStatus,
  createDefaultConnectOnceService: vi.fn(() => ({
    startConnect: vi.fn(async () => ({ status: "coming_soon", reason: "not under test" })),
  })),
}));

vi.mock("../../src/db/repositories/approvals.js", () => ({
  getRequest,
  recordExecution,
}));

vi.mock("../../src/db/repositories/external-credentials.js", () => ({
  listServiceStatuses: vi.fn(async () => []),
  setServiceCredentials,
  revokeServiceCredentials: vi.fn(),
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
  process.env.AGENT_CREDENTIALS_ENC_KEY = STATE_SECRET;
  getRequest.mockResolvedValue(approval());
  recordExecution.mockResolvedValue({ outcome: "recorded", request: approval({ status: "executed" }) });
  setServiceCredentials.mockResolvedValue({
    serviceKey: "google",
    connected: true,
    status: "connected",
    fingerprint: "fp_google",
    envKeys: ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_SCOPE"],
    scopes: ["search_console"],
    rotationReminderDays: null,
    connectedAtMs: Date.now(),
    revokedAtMs: null,
  });
  googleConnectionOAuthConfigStatus.mockReturnValue({
    configured: false,
    missing: ["GOOGLE_CONNECTION_OAUTH_REDIRECT_URI"],
    callbackPath: "/me/connections/google/oauth/callback",
  });
});

afterEach(() => {
  if (ORIGINAL_ENC_KEY === undefined) {
    delete process.env.AGENT_CREDENTIALS_ENC_KEY;
  } else {
    process.env.AGENT_CREDENTIALS_ENC_KEY = ORIGINAL_ENC_KEY;
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

  it("exchanges a valid callback, seals the credential, and records non-secret proof", async () => {
    const exchange = vi.fn(async () => ({
      capabilities: ["search_console"],
      secrets: {
        GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
        GOOGLE_OAUTH_SCOPE: "https://www.googleapis.com/auth/webmasters.readonly",
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
      expect(setServiceCredentials).toHaveBeenCalledWith({
        workspaceId: OWNER,
        serviceKey: "google",
        secrets: {
          GOOGLE_OAUTH_ACCESS_TOKEN: "access-token",
          GOOGLE_OAUTH_SCOPE: "https://www.googleapis.com/auth/webmasters.readonly",
        },
        scopes: ["search_console"],
        connectedByMemberId: MEMBER,
      });
      expect(recordExecution).toHaveBeenCalledWith("req-1", OWNER, {
        ok: true,
        result: {
          connectionId: "google",
          provider: "google",
          envKeys: ["GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_OAUTH_SCOPE"],
          fingerprint: "fp_google",
          scopes: ["search_console"],
        },
      });
      expect(String(res.headers.location)).not.toContain("access-token");
    } finally {
      await app.close();
    }
  });
});
