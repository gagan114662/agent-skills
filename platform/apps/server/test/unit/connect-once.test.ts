import { describe, it, expect } from "vitest";
import {
  CONNECT_ONCE_DEFAULTS,
  resolveConnectOnceCaps,
  isConnectOnceLiveInScope,
  type ConnectOnceCaps,
} from "../../src/connections/caps.js";
import { signConnectState, verifyConnectState } from "../../src/connections/state.js";
import {
  DryRunConnectProvider,
  MockConnectProvider,
  OAuthConnectProvider,
  createConnectProvider,
  isValidAuthCode,
  EMPTY_EXCHANGE,
  type ConnectExchangeResult,
  type OAuthClientConfig,
} from "../../src/connections/provider.js";
import {
  decideApprovedConnectRequest,
  decideConnectStart,
  mapExchangeToSeal,
} from "../../src/connections/connect.js";
import {
  decideConnectedCapabilities,
  hasConnectedCapability,
} from "../../src/connections/capabilities.js";
import {
  ConnectOnceService,
  type ConnectOnceDeps,
  type ConnectIdentity,
} from "../../src/connections/service.js";
import {
  getConnectionDescriptor,
  CONNECTION_DESCRIPTORS,
  type ConnectionDescriptor,
} from "../../src/connections/registry.js";
import {
  defaultConnectProvider,
  googleConnectionOAuthConfigStatus,
} from "../../src/connections/default.js";
import type { ApprovalRequest } from "../../src/db/repositories/approvals.js";
import { CONNECTION_CONNECT_ACCOUNT_ACTION } from "../../src/approvals/policy.js";

const SECRET = "test-connect-once-secret";
const OWNER = "ws-owner";
const OTHER = "ws-other";

const GOOGLE = getConnectionDescriptor("google") as ConnectionDescriptor;
const SITE_PUBLISH = getConnectionDescriptor("site_publish_github") as ConnectionDescriptor;

// --------------------------------------------------------------------------------------------------
// caps — default OFF, owner-workspace-first
// --------------------------------------------------------------------------------------------------
describe("connectOnce caps (#258 Stage 2) — default OFF, owner-workspace-first", () => {
  it("defaults to disabled + owner-workspace-first when no config block is set", () => {
    expect(CONNECT_ONCE_DEFAULTS).toEqual({
      enabled: false,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: null,
    });
    expect(resolveConnectOnceCaps(undefined)).toEqual(CONNECT_ONCE_DEFAULTS);
  });

  it("fills hard defaults for a partial config", () => {
    expect(resolveConnectOnceCaps({ enabled: true })).toEqual({
      enabled: true,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: null,
    });
  });

  it("is out of scope when disabled, regardless of workspace", () => {
    const caps = resolveConnectOnceCaps({ enabled: false, ownerWorkspaceId: OWNER });
    expect(isConnectOnceLiveInScope(caps, OWNER)).toBe(false);
  });

  it("owner-first: only the owner workspace is in scope when ownerWorkspaceOnly", () => {
    const caps = resolveConnectOnceCaps({ enabled: true, ownerWorkspaceId: OWNER });
    expect(isConnectOnceLiveInScope(caps, OWNER)).toBe(true);
    expect(isConnectOnceLiveInScope(caps, OTHER)).toBe(false);
  });

  it("enabled WITHOUT naming the owner lets nobody in (fail-closed)", () => {
    const caps = resolveConnectOnceCaps({ enabled: true });
    expect(isConnectOnceLiveInScope(caps, OWNER)).toBe(false);
  });

  it("fleet-wide: every workspace is in scope when ownerWorkspaceOnly is false", () => {
    const caps = resolveConnectOnceCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isConnectOnceLiveInScope(caps, OTHER)).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------------
// state — HMAC binding {workspaceId, connectionId, nonce}
// --------------------------------------------------------------------------------------------------
describe("connectOnce state (#258 Stage 2) — HMAC, no DB, workspace+connection bound", () => {
  const now = 1_700_000_000_000;

  it("round-trips a valid state", () => {
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", nonce: "n1" },
      SECRET,
      now,
    );
    expect(verifyConnectState(state, SECRET, { now })).toEqual({
      workspaceId: OWNER,
      connectionId: "google",
      nonce: "n1",
    });
  });

  it("round-trips the approval request id that is allowed to execute the callback", () => {
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", approvalRequestId: "req-1", nonce: "n1" },
      SECRET,
      now,
    );
    expect(verifyConnectState(state, SECRET, { now })).toEqual({
      workspaceId: OWNER,
      connectionId: "google",
      approvalRequestId: "req-1",
      nonce: "n1",
    });
  });

  it("rejects a tampered body", () => {
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", nonce: "n1" },
      SECRET,
      now,
    );
    const [, mac] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ workspaceId: OTHER, connectionId: "google", nonce: "n1", ts: now }),
      "utf8",
    ).toString("base64url");
    expect(verifyConnectState(`${forged}.${mac}`, SECRET, { now })).toBeNull();
  });

  it("rejects the wrong secret", () => {
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", nonce: "n1" },
      SECRET,
      now,
    );
    expect(verifyConnectState(state, "other-secret", { now })).toBeNull();
  });

  it("rejects an expired state and a future-dated one", () => {
    const state = signConnectState(
      { workspaceId: OWNER, connectionId: "google", nonce: "n1" },
      SECRET,
      now,
    );
    expect(verifyConnectState(state, SECRET, { now: now + 11 * 60 * 1000 })).toBeNull();
    expect(verifyConnectState(state, SECRET, { now: now - 5 * 60 * 1000 })).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyConnectState("nodot", SECRET, { now })).toBeNull();
    expect(verifyConnectState("", SECRET, { now })).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------------
// provider — adapters, injection defense, live-vs-dryrun selection
// --------------------------------------------------------------------------------------------------
describe("connectOnce provider (#258 Stage 2) — adapters + injection defense", () => {
  it("the dry-run provider never mints and is not live", async () => {
    const p = new DryRunConnectProvider();
    expect(p.live).toBe(false);
    expect(p.authorizeUrl({ state: "s" })).not.toMatch(/^https?:/);
    expect(await p.exchange({ code: "c", state: "s" })).toEqual(EMPTY_EXCHANGE);
  });

  it("the mock provider returns synthetic non-secret placeholders + the granted capabilities", async () => {
    const p = new MockConnectProvider({
      connectionId: "google",
      capabilities: ["search_console", "analytics"],
    });
    expect(p.live).toBe(true);
    const result = await p.exchange({ code: "c", state: "s" });
    expect(result.capabilities).toEqual(["search_console", "analytics"]);
    // Clearly synthetic — never a real credential.
    for (const v of Object.values(result.secrets)) expect(v).toMatch(/^mock:/);
  });

  it("isValidAuthCode accepts a bare URL-safe code and rejects poisoned input", () => {
    expect(isValidAuthCode("abc-123._~")).toBe(true);
    expect(isValidAuthCode("code with space")).toBe(false);
    expect(isValidAuthCode("code&extra=1")).toBe(false);
    expect(isValidAuthCode("../../etc")).toBe(false);
    expect(isValidAuthCode("with\nnewline")).toBe(false);
    expect(isValidAuthCode("")).toBe(false);
    expect(isValidAuthCode(123)).toBe(false);
  });

  it("createConnectProvider returns dry-run when no client is configured, live when one is", () => {
    const map = (): ConnectExchangeResult => EMPTY_EXCHANGE;
    expect(createConnectProvider({ client: null, mapTokens: map }).live).toBe(false);
    const client: OAuthClientConfig = {
      clientId: "id",
      clientSecret: "sec",
      authorizeUrl: "https://idp.example/auth",
      tokenUrl: "https://idp.example/token",
      redirectUri: "https://app.example/cb",
      scopes: ["a", "b"],
    };
    const live = createConnectProvider({ client, mapTokens: map });
    expect(live.live).toBe(true);
    expect(live).toBeInstanceOf(OAuthConnectProvider);
    const url = live.authorizeUrl({ state: "xyz" });
    expect(url).toContain("https://idp.example/auth?");
    expect(url).toContain("state=xyz");
    expect(url).toContain("scope=a+b");
    expect(url).toContain("client_id=id");
  });

  it("defaultConnectProvider derives the Google connection callback from the API Google redirect (#1285)", () => {
    expect(
      googleConnectionOAuthConfigStatus({
        GOOGLE_OAUTH_CLIENT_ID: "cid",
        GOOGLE_OAUTH_CLIENT_SECRET: "secret",
        GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({
      configured: true,
      missing: [],
      callbackPath: "/me/connections/google/oauth/callback",
    });

    const derivedProvider = defaultConnectProvider("google", {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
    } as NodeJS.ProcessEnv);
    expect(derivedProvider.live).toBe(true);
    expect(derivedProvider.authorizeUrl({ state: "state-1" })).toContain(
      "redirect_uri=https%3A%2F%2Fapi.ipop.ai%2Fme%2Fconnections%2Fgoogle%2Foauth%2Fcallback",
    );

    const provider = defaultConnectProvider("google", {
      GOOGLE_OAUTH_CLIENT_ID: "cid",
      GOOGLE_OAUTH_CLIENT_SECRET: "secret",
      GOOGLE_CONNECTION_OAUTH_REDIRECT_URI:
        "https://api.ipop.ai/me/connections/google/oauth/callback",
    } as NodeJS.ProcessEnv);
    expect(provider.live).toBe(true);
    const url = provider.authorizeUrl({ state: "state-1" });
    expect(url).toContain("client_id=cid");
    expect(url).toContain("state=state-1");
    expect(url).toContain(
      "redirect_uri=https%3A%2F%2Fapi.ipop.ai%2Fme%2Fconnections%2Fgoogle%2Foauth%2Fcallback",
    );
  });
});

// --------------------------------------------------------------------------------------------------
// connect — decideConnectStart + mapExchangeToSeal
// --------------------------------------------------------------------------------------------------
describe("decideConnectStart (#258 Stage 2)", () => {
  const inScope = resolveConnectOnceCaps({ enabled: true, ownerWorkspaceId: OWNER });

  it("coming_soon for a non-OAuth / unknown connector", () => {
    expect(
      decideConnectStart({
        descriptor: undefined,
        caps: inScope,
        workspaceId: OWNER,
        liveProviderConfigured: true,
      }).outcome,
    ).toBe("coming_soon");
    expect(
      decideConnectStart({
        descriptor: SITE_PUBLISH,
        caps: inScope,
        workspaceId: OWNER,
        liveProviderConfigured: true,
      }).outcome,
    ).toBe("coming_soon");
  });

  it("coming_soon when out of scope (flag off / not owner)", () => {
    const off = resolveConnectOnceCaps(undefined);
    expect(
      decideConnectStart({
        descriptor: GOOGLE,
        caps: off,
        workspaceId: OWNER,
        liveProviderConfigured: true,
      }).outcome,
    ).toBe("coming_soon");
    expect(
      decideConnectStart({
        descriptor: GOOGLE,
        caps: inScope,
        workspaceId: OTHER,
        liveProviderConfigured: true,
      }).outcome,
    ).toBe("coming_soon");
  });

  it("coming_soon when in scope but no live provider is wired", () => {
    expect(
      decideConnectStart({
        descriptor: GOOGLE,
        caps: inScope,
        workspaceId: OWNER,
        liveProviderConfigured: false,
      }).outcome,
    ).toBe("coming_soon");
  });

  it("needs_approval only when in scope AND live AND an OAuth connector", () => {
    expect(
      decideConnectStart({
        descriptor: GOOGLE,
        caps: inScope,
        workspaceId: OWNER,
        liveProviderConfigured: true,
      }),
    ).toEqual({ outcome: "needs_approval" });
  });
});

describe("mapExchangeToSeal (#258 Stage 2) — never seal a blank", () => {
  it("refuses to seal when the exchange minted no credential", () => {
    expect(mapExchangeToSeal({ descriptor: GOOGLE, exchange: EMPTY_EXCHANGE }).seal).toBe(false);
    expect(
      mapExchangeToSeal({
        descriptor: GOOGLE,
        exchange: { capabilities: ["x"], secrets: { K: "  " } },
      }).seal,
    ).toBe(false);
  });

  it("seals secrets + granted capabilities as the vault scopes", () => {
    const decision = mapExchangeToSeal({
      descriptor: GOOGLE,
      exchange: { capabilities: ["search_console"], secrets: { GOOGLE_TOKEN: "t" } },
    });
    expect(decision).toEqual({
      seal: true,
      serviceKey: "google",
      serviceKind: GOOGLE.kind,
      scopes: ["search_console"],
      secrets: { GOOGLE_TOKEN: "t" },
    });
  });

  it("falls back to the descriptor capabilities when the provider returned none", () => {
    const decision = mapExchangeToSeal({
      descriptor: GOOGLE,
      exchange: { capabilities: [], secrets: { GOOGLE_TOKEN: "t" } },
    });
    expect(decision.seal && decision.scopes).toEqual([...GOOGLE.capabilities]);
  });
});

describe("decideApprovedConnectRequest (#1285) — exact owner-approved consent only", () => {
  function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
    const now = new Date("2026-06-27T00:00:00Z");
    return {
      id: "req-1",
      workspaceId: OWNER,
      requesterMemberId: "m1",
      actionType: CONNECTION_CONNECT_ACCOUNT_ACTION,
      payload: { connectionId: "google", provider: "google" },
      amount: null,
      summary: "Connect Google",
      status: "approved",
      reason: null,
      decidedByMemberId: "owner",
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

  it("accepts an approved connection request for the same workspace and connector", () => {
    const decision = decideApprovedConnectRequest({
      request: request(),
      workspaceId: OWNER,
      connectionId: "google",
    });
    expect(decision.ok).toBe(true);
  });

  it("rejects missing, cross-workspace, wrong-action, wrong-connector, and non-approved requests", () => {
    expect(
      decideApprovedConnectRequest({ request: undefined, workspaceId: OWNER, connectionId: "google" }),
    ).toMatchObject({ ok: false, statusCode: 404 });
    expect(
      decideApprovedConnectRequest({
        request: request({ workspaceId: OTHER }),
        workspaceId: OWNER,
        connectionId: "google",
      }),
    ).toMatchObject({ ok: false, statusCode: 403 });
    expect(
      decideApprovedConnectRequest({
        request: request({ actionType: "external.send" }),
        workspaceId: OWNER,
        connectionId: "google",
      }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(
      decideApprovedConnectRequest({
        request: request({ payload: { connectionId: "x", provider: "x" } }),
        workspaceId: OWNER,
        connectionId: "google",
      }),
    ).toMatchObject({ ok: false, statusCode: 400 });
    expect(
      decideApprovedConnectRequest({
        request: request({ status: "pending" }),
        workspaceId: OWNER,
        connectionId: "google",
      }),
    ).toMatchObject({ ok: false, statusCode: 409 });
  });
});

// --------------------------------------------------------------------------------------------------
// capabilities — the downstream read side (#265/#269/#272 gate on this)
// --------------------------------------------------------------------------------------------------
describe("decideConnectedCapabilities (#258 Stage 2)", () => {
  it("resolves to the empty set when nothing is connected", () => {
    const caps = decideConnectedCapabilities({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: new Set(),
    });
    expect(caps.size).toBe(0);
  });

  it("unlocks a connector's declared capabilities once connected", () => {
    const caps = decideConnectedCapabilities({
      descriptors: CONNECTION_DESCRIPTORS,
      connectedIds: new Set(["google", "x"]),
    });
    expect(caps.has("search_console")).toBe(true);
    expect(caps.has("analytics")).toBe(true);
    expect(caps.has("post_social")).toBe(true);
    expect(
      hasConnectedCapability({
        descriptors: CONNECTION_DESCRIPTORS,
        connectedIds: new Set(["google"]),
        capability: "search_console",
      }),
    ).toBe(true);
    expect(
      hasConnectedCapability({
        descriptors: CONNECTION_DESCRIPTORS,
        connectedIds: new Set(),
        capability: "search_console",
      }),
    ).toBe(false);
  });
});

// --------------------------------------------------------------------------------------------------
// service — parks the owner approval only when in scope + live; never auto-connects
// --------------------------------------------------------------------------------------------------
describe("ConnectOnceService (#258 Stage 2) — always-gate, no autonomous connect", () => {
  function build(opts: { caps: ConnectOnceCaps; live: boolean }): {
    service: ConnectOnceService;
    parked: { count: number };
  } {
    const parked = { count: 0 };
    const deps: ConnectOnceDeps = {
      caps: () => opts.caps,
      provider: () =>
        opts.live
          ? new MockConnectProvider({ connectionId: "google", capabilities: ["search_console"] })
          : new DryRunConnectProvider(),
      park: async () => {
        parked.count += 1;
        return { id: "req-1" };
      },
    };
    return { service: new ConnectOnceService(deps), parked };
  }

  const identity: ConnectIdentity = { workspaceId: OWNER, requesterMemberId: "m1" };

  it("returns coming_soon and parks NOTHING when the live flow is out of scope", async () => {
    const { service, parked } = build({ caps: resolveConnectOnceCaps(undefined), live: true });
    const result = await service.startConnect(identity, GOOGLE);
    expect(result.status).toBe("coming_soon");
    expect(parked.count).toBe(0);
  });

  it("returns coming_soon when in scope but the provider is not live", async () => {
    const { service, parked } = build({
      caps: resolveConnectOnceCaps({ enabled: true, ownerWorkspaceId: OWNER }),
      live: false,
    });
    const result = await service.startConnect(identity, GOOGLE);
    expect(result.status).toBe("coming_soon");
    expect(parked.count).toBe(0);
  });

  it("parks a PENDING owner approval when in scope + live, returning its request id", async () => {
    const { service, parked } = build({
      caps: resolveConnectOnceCaps({ enabled: true, ownerWorkspaceId: OWNER }),
      live: true,
    });
    const result = await service.startConnect(identity, GOOGLE);
    expect(result).toEqual({ status: "pending_approval", requestId: "req-1" });
    expect(parked.count).toBe(1);
  });
});
