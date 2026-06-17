import { describe, it, expect } from "vitest";
import {
  CLAUDE_CONNECT_SERVICE_KEY,
  CONNECT_CLAUDE_DEFAULTS,
  resolveConnectClaudeCaps,
  isConnectClaudeInScope,
  decideClaudeConnectOffer,
  isValidAuthCode,
  signConnectState,
  verifyConnectState,
  loadClaudeOAuthConfig,
  buildClaudeAuthorizeUrl,
  mapClaudeTokenResponse,
  DryRunClaudeConnectProvider,
  LiveClaudeConnectProvider,
  createClaudeConnectProvider,
  CLAUDE_OAUTH_DEFAULT_SCOPES,
} from "../../src/auth/claude-connect.js";

const SECRET = "test-connect-secret";
const OWNER = "ws-owner";
const OTHER = "ws-other";

describe("connectClaude caps (#262) — default OFF, owner-workspace-first", () => {
  it("defaults to disabled + owner-workspace-first when no config block is set", () => {
    expect(CONNECT_CLAUDE_DEFAULTS).toEqual({
      enabled: false,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: null,
    });
    expect(resolveConnectClaudeCaps(undefined)).toEqual(CONNECT_CLAUDE_DEFAULTS);
  });

  it("fills hard defaults for a partial config", () => {
    expect(resolveConnectClaudeCaps({ enabled: true })).toEqual({
      enabled: true,
      ownerWorkspaceOnly: true,
      ownerWorkspaceId: null,
    });
    expect(
      resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: OWNER }),
    ).toEqual({ enabled: true, ownerWorkspaceOnly: false, ownerWorkspaceId: OWNER });
  });

  it("is out of scope when disabled, regardless of workspace", () => {
    const caps = resolveConnectClaudeCaps({ enabled: false, ownerWorkspaceId: OWNER });
    expect(isConnectClaudeInScope(caps, OWNER)).toBe(false);
  });

  it("owner-first: only the owner workspace is in scope when ownerWorkspaceOnly", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceId: OWNER });
    expect(isConnectClaudeInScope(caps, OWNER)).toBe(true);
    expect(isConnectClaudeInScope(caps, OTHER)).toBe(false);
  });

  it("enabled fleet-wide: every workspace is in scope when ownerWorkspaceOnly is false", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isConnectClaudeInScope(caps, OTHER)).toBe(true);
  });

  it("enabled but no ownerWorkspaceId set: owner-first means nobody is in scope (fail-closed)", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true });
    expect(isConnectClaudeInScope(caps, OWNER)).toBe(false);
  });
});

describe("decideClaudeConnectOffer (#262)", () => {
  it("offers the manual paste (today's behavior) when managed connect is out of scope", () => {
    const caps = resolveConnectClaudeCaps(undefined);
    const offer = decideClaudeConnectOffer({ caps, workspaceId: OWNER, liveProviderConfigured: false });
    expect(offer.method).toBe("paste_token");
    expect(offer.managed).toBe(false);
    expect(offer.status).toBe("available"); // the paste path is always available — never a dead end
  });

  it("offers managed OAuth as available when in scope AND a live client is configured", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceId: OWNER });
    const offer = decideClaudeConnectOffer({ caps, workspaceId: OWNER, liveProviderConfigured: true });
    expect(offer.method).toBe("managed_oauth");
    expect(offer.managed).toBe(true);
    expect(offer.status).toBe("available");
  });

  it("is honest: managed OAuth in scope but no live client → coming_soon (never claims it works)", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceId: OWNER });
    const offer = decideClaudeConnectOffer({ caps, workspaceId: OWNER, liveProviderConfigured: false });
    expect(offer.method).toBe("managed_oauth");
    expect(offer.managed).toBe(true);
    expect(offer.status).toBe("coming_soon");
    expect(offer.reason).toBeTruthy();
  });

  it("a non-owner workspace gets the paste path even when the owner has managed connect on", () => {
    const caps = resolveConnectClaudeCaps({ enabled: true, ownerWorkspaceId: OWNER });
    const offer = decideClaudeConnectOffer({ caps, workspaceId: OTHER, liveProviderConfigured: true });
    expect(offer.method).toBe("paste_token");
    expect(offer.managed).toBe(false);
  });
});

describe("isValidAuthCode (#262, premortem #200 §6 injection defense)", () => {
  it("accepts a normal URL-safe OAuth authorization code", () => {
    expect(isValidAuthCode("ac_0123456789.AbC-de_f~xyz")).toBe(true);
  });

  it("rejects non-strings, empty, and over-long codes", () => {
    expect(isValidAuthCode(undefined)).toBe(false);
    expect(isValidAuthCode(123 as unknown)).toBe(false);
    expect(isValidAuthCode("")).toBe(false);
    expect(isValidAuthCode("a".repeat(4097))).toBe(false);
  });

  it("rejects a poisoned code carrying injection / traversal / whitespace payloads", () => {
    expect(isValidAuthCode("code&redirect_uri=https://evil.test")).toBe(false);
    expect(isValidAuthCode("../../etc/passwd")).toBe(false);
    expect(isValidAuthCode("code with spaces")).toBe(false);
    expect(isValidAuthCode("<script>alert(1)</script>")).toBe(false);
    expect(isValidAuthCode("code\n%0d%0a")).toBe(false);
  });
});

describe("connect OAuth state (#262) — HMAC, no DB, tenant-bound", () => {
  it("round-trips the workspaceId + nonce through a signed state", () => {
    const state = signConnectState({ workspaceId: OWNER, nonce: "n1" }, SECRET, 1000);
    expect(verifyConnectState(state, SECRET, { now: 1000 })).toEqual({ workspaceId: OWNER, nonce: "n1" });
  });

  it("rejects a state signed with a different secret (tamper-evident)", () => {
    const state = signConnectState({ workspaceId: OWNER, nonce: "n1" }, SECRET, 1000);
    expect(verifyConnectState(state, "other", { now: 1000 })).toBeNull();
  });

  it("rejects an expired state and a future-dated state (replay bound)", () => {
    const state = signConnectState({ workspaceId: OWNER, nonce: "n1" }, SECRET, 1000);
    expect(verifyConnectState(state, SECRET, { now: 1000 + 11 * 60 * 1000 })).toBeNull();
    const future = signConnectState({ workspaceId: OWNER, nonce: "n1" }, SECRET, 10_000_000);
    expect(verifyConnectState(future, SECRET, { now: 1000 })).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyConnectState("", SECRET)).toBeNull();
    expect(verifyConnectState("nodot", SECRET)).toBeNull();
  });
});

describe("loadClaudeOAuthConfig (#262) — env-driven, OFF when unset", () => {
  it("returns null when the OAuth client env is not configured (feature degrades honestly)", () => {
    expect(loadClaudeOAuthConfig({} as NodeJS.ProcessEnv)).toBeNull();
    // partial config is still null — never a half-wired live flow
    expect(loadClaudeOAuthConfig({ CLAUDE_OAUTH_CLIENT_ID: "x" } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns the config when all required env vars are present", () => {
    const cfg = loadClaudeOAuthConfig({
      CLAUDE_OAUTH_CLIENT_ID: "client-123",
      CLAUDE_OAUTH_AUTHORIZE_URL: "https://auth.example.test/authorize",
      CLAUDE_OAUTH_TOKEN_URL: "https://auth.example.test/token",
      CLAUDE_OAUTH_REDIRECT_URI: "https://app.test/me/claude/connect/callback",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({
      clientId: "client-123",
      authorizeUrl: "https://auth.example.test/authorize",
      tokenUrl: "https://auth.example.test/token",
      redirectUri: "https://app.test/me/claude/connect/callback",
    });
  });
});

describe("buildClaudeAuthorizeUrl (#262)", () => {
  const cfg = {
    clientId: "client-123",
    authorizeUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    redirectUri: "https://app.test/me/claude/connect/callback",
  };

  it("builds a code-flow authorize URL with the state, redirect and default scopes", () => {
    const url = new URL(buildClaudeAuthorizeUrl({ config: cfg, state: "st-1" }));
    expect(url.origin + url.pathname).toBe("https://auth.example.test/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(cfg.redirectUri);
    expect(url.searchParams.get("state")).toBe("st-1");
    expect(url.searchParams.get("scope")).toBe(CLAUDE_OAUTH_DEFAULT_SCOPES.join(" "));
  });
});

describe("mapClaudeTokenResponse (#262)", () => {
  it("extracts the subscription oauth token from a token response", () => {
    expect(mapClaudeTokenResponse({ access_token: "sk-ant-oat-abc" })).toEqual({ token: "sk-ant-oat-abc" });
  });

  it("returns null token for a malformed / empty response (never a blank credential)", () => {
    expect(mapClaudeTokenResponse({})).toEqual({ token: null });
    expect(mapClaudeTokenResponse({ access_token: "" })).toEqual({ token: null });
    expect(mapClaudeTokenResponse(null)).toEqual({ token: null });
    expect(mapClaudeTokenResponse("nope")).toEqual({ token: null });
  });
});

describe("DryRunClaudeConnectProvider (#262) — the default: never mints a real token", () => {
  it("is not live and exchanges to a null token (nothing real happens without a wired client)", async () => {
    const p = new DryRunClaudeConnectProvider();
    expect(p.live).toBe(false);
    expect(p.authorizeUrl({ state: "st" })).not.toContain("https://");
    await expect(p.exchange({ code: "ac_x", state: "st" })).resolves.toEqual({ token: null });
  });
});

describe("LiveClaudeConnectProvider (#262) — only constructed when a real client is configured", () => {
  const cfg = {
    clientId: "client-123",
    authorizeUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    redirectUri: "https://app.test/me/claude/connect/callback",
  };

  it("is live and builds a real authorize URL bound to the state", () => {
    const p = new LiveClaudeConnectProvider(cfg);
    expect(p.live).toBe(true);
    const url = new URL(p.authorizeUrl({ state: "st-9" }));
    expect(url.origin + url.pathname).toBe("https://auth.example.test/authorize");
    expect(url.searchParams.get("state")).toBe("st-9");
    expect(url.searchParams.get("client_id")).toBe("client-123");
  });
});

describe("createClaudeConnectProvider (#262) — dry-run unless a live client is configured", () => {
  it("returns the dry-run provider when env is unset (default deployment)", () => {
    const p = createClaudeConnectProvider({} as NodeJS.ProcessEnv);
    expect(p.live).toBe(false);
    expect(p).toBeInstanceOf(DryRunClaudeConnectProvider);
  });

  it("returns the live provider when the full OAuth client env is present", () => {
    const p = createClaudeConnectProvider({
      CLAUDE_OAUTH_CLIENT_ID: "client-123",
      CLAUDE_OAUTH_AUTHORIZE_URL: "https://auth.example.test/authorize",
      CLAUDE_OAUTH_TOKEN_URL: "https://auth.example.test/token",
      CLAUDE_OAUTH_REDIRECT_URI: "https://app.test/cb",
    } as NodeJS.ProcessEnv);
    expect(p.live).toBe(true);
    expect(p).toBeInstanceOf(LiveClaudeConnectProvider);
  });
});

describe("service key (#262)", () => {
  it("uses the dedicated 'claude' connect service key", () => {
    expect(CLAUDE_CONNECT_SERVICE_KEY).toBe("claude");
  });
});
