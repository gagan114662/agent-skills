import { describe, it, expect } from "vitest";
import {
  CAPABILITY_TOKEN_DEFAULT_KEY_ID,
  signCapabilityToken,
  verifyCapabilityToken,
  isCapabilityTokenExpired,
  isTokenVerb,
  type CapabilityTokenClaims,
} from "../../src/connections/token.js";
import {
  loadCapabilityTokenKeyId,
  loadCapabilityTokenSecret,
} from "../../src/connections/token-default.js";
import {
  CAPABILITY_TOKEN_DEFAULTS,
  TTL_FLOOR_SECONDS,
  TTL_CEILING_SECONDS,
  resolveCapabilityTokenCaps,
  isCapabilityMintLiveInScope,
  type CapabilityTokenCaps,
} from "../../src/connections/token-caps.js";
import { decideTokenMint, clampTtl } from "../../src/connections/token-mint.js";
import {
  DryRunCapabilityTokenProvider,
  MockCapabilityTokenProvider,
  normalizeVerification,
  sanitizeProviderText,
  type CapabilityTokenProvider,
  type TokenVerification,
} from "../../src/connections/token-provider.js";
import {
  CapabilityTokenService,
  type CapabilityTokenDeps,
  type MintRecordStore,
  type MintAuditInput,
  type StoredMint,
} from "../../src/connections/token-service.js";

const SECRET = "test-capability-token-secret";
const OWNER = "ws-owner";
const OTHER = "ws-other";
const NOW = 1_700_000_000_000;
// Build control chars from char codes so the source never carries a raw escape the editor can mangle.
const NL = String.fromCharCode(10);
const CONTROL_CHARS = new RegExp(
  "[" + String.fromCharCode(10) + String.fromCharCode(13) + String.fromCharCode(9) + "]",
);

function claims(over: Partial<CapabilityTokenClaims> = {}): CapabilityTokenClaims {
  return {
    workspaceId: OWNER,
    kid: CAPABILITY_TOKEN_DEFAULT_KEY_ID,
    connectionId: "google",
    capability: "search_console",
    verb: "read",
    delegation: { memberId: "m1", agentId: "scout" },
    approvalRequestId: null,
    jti: "jti-1",
    iat: NOW,
    exp: NOW + 300_000,
    ...over,
  };
}

const inScopeCaps = resolveCapabilityTokenCaps({ liveMintEnabled: true, ownerWorkspaceId: OWNER });

// --------------------------------------------------------------------------------------------------
// token codec — HMAC sign/verify, TTL expiry, tamper, delegation chain round-trip
// --------------------------------------------------------------------------------------------------
describe("capability token codec (#336) — sign/verify, TTL, delegation", () => {
  it("round-trips a valid token incl. the delegation chain", () => {
    const token = signCapabilityToken(claims(), SECRET);
    expect(verifyCapabilityToken(token, SECRET, { now: NOW })).toEqual(claims());
  });

  it("signed tokens carry a key id for rotation", () => {
    const token = signCapabilityToken(claims({ kid: "capability-token:v2" }), SECRET);
    const [body] = token.split(".");
    const raw = JSON.parse(Buffer.from(body!, "base64url").toString("utf8")) as { kid?: string };

    expect(raw.kid).toBe("capability-token:v2");
    expect(verifyCapabilityToken(token, SECRET, { now: NOW })?.kid).toBe("capability-token:v2");
  });

  it("carries the user->agent->service delegation + approval pre-commitment for a write", () => {
    const c = claims({ verb: "write", approvalRequestId: "req-42", delegation: { memberId: "m9", agentId: "echo" } });
    const decoded = verifyCapabilityToken(signCapabilityToken(c, SECRET), SECRET, { now: NOW });
    expect(decoded?.delegation).toEqual({ memberId: "m9", agentId: "echo" });
    expect(decoded?.approvalRequestId).toBe("req-42");
  });

  it("rejects the wrong secret", () => {
    const token = signCapabilityToken(claims(), SECRET);
    expect(verifyCapabilityToken(token, "other-secret", { now: NOW })).toBeNull();
  });

  it("rejects a tampered body (reused mac)", () => {
    const token = signCapabilityToken(claims(), SECRET);
    const mac = token.slice(token.indexOf(".") + 1);
    const forged = Buffer.from(JSON.stringify(claims({ capability: "analytics" })), "utf8").toString("base64url");
    expect(verifyCapabilityToken(`${forged}.${mac}`, SECRET, { now: NOW })).toBeNull();
  });

  it("rejects an expired token (TTL passed) and a future-dated one", () => {
    const token = signCapabilityToken(claims(), SECRET); // exp = NOW + 300s
    expect(verifyCapabilityToken(token, SECRET, { now: NOW + 300_001 })).toBeNull();
    const future = signCapabilityToken(claims({ iat: NOW + 5 * 60_000, exp: NOW + 6 * 60_000 }), SECRET);
    expect(verifyCapabilityToken(future, SECRET, { now: NOW })).toBeNull();
  });

  it("rejects malformed input and correctly-signed-but-wrong-shape bodies (array / missing field)", () => {
    expect(verifyCapabilityToken("nodot", SECRET, { now: NOW })).toBeNull();
    expect(verifyCapabilityToken("", SECRET, { now: NOW })).toBeNull();
    // A correctly-signed body whose JSON is an array must still be rejected by the shape guard.
    expect(verifyCapabilityToken(signCapabilityToken([1, 2, 3] as never, SECRET), SECRET, { now: NOW })).toBeNull();
    // A correctly-signed object missing the delegation chain must be rejected too.
    const noDelegation = { ...claims() } as Partial<CapabilityTokenClaims>;
    delete noDelegation.delegation;
    expect(verifyCapabilityToken(signCapabilityToken(noDelegation as never, SECRET), SECRET, { now: NOW })).toBeNull();
  });

  it("isCapabilityTokenExpired is a pure TTL predicate", () => {
    expect(isCapabilityTokenExpired(claims({ exp: NOW + 1 }), NOW)).toBe(false);
    expect(isCapabilityTokenExpired(claims({ exp: NOW }), NOW)).toBe(true);
  });

  it("isTokenVerb guards the verb union", () => {
    expect(isTokenVerb("read")).toBe(true);
    expect(isTokenVerb("write")).toBe(true);
    expect(isTokenVerb("admin")).toBe(false);
    expect(isTokenVerb(1)).toBe(false);
  });
});

describe("capability-token default signing secret (#927)", () => {
  it("prefers explicit secret, then enc key, then an ephemeral non-production secret", () => {
    expect(loadCapabilityTokenSecret({ CAPABILITY_TOKEN_SECRET: "cap" } as NodeJS.ProcessEnv)).toBe("cap");
    expect(loadCapabilityTokenSecret({ AGENT_CREDENTIALS_ENC_KEY: "enc" } as NodeJS.ProcessEnv)).toBe("enc");
    const fallback = loadCapabilityTokenSecret({} as NodeJS.ProcessEnv);
    expect(fallback).toMatch(/^dev-capability-token-/);
    expect(fallback).not.toContain("ipop");
  });

  it("fails closed in production without a configured secret", () => {
    expect(() => loadCapabilityTokenSecret({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(
      /CAPABILITY_TOKEN_SECRET/,
    );
  });

  it("loads a non-secret signing key id for rotation audits", () => {
    expect(loadCapabilityTokenKeyId({ CAPABILITY_TOKEN_KEY_ID: "cap-k2" } as NodeJS.ProcessEnv)).toBe("cap-k2");
    expect(loadCapabilityTokenKeyId({ AGENT_CREDENTIALS_KEY_ID: "enc-k3" } as NodeJS.ProcessEnv)).toBe("enc-k3");
    expect(loadCapabilityTokenKeyId({} as NodeJS.ProcessEnv)).toBe(CAPABILITY_TOKEN_DEFAULT_KEY_ID);
  });
});

// --------------------------------------------------------------------------------------------------
// caps — default OFF, owner-first, TTL bounds clamped
// --------------------------------------------------------------------------------------------------
describe("capability-token caps (#336) — default OFF, owner-first, TTL bounds", () => {
  it("defaults to disabled + owner-first + bounded TTLs", () => {
    expect(CAPABILITY_TOKEN_DEFAULTS.liveMintEnabled).toBe(false);
    expect(CAPABILITY_TOKEN_DEFAULTS.ownerWorkspaceOnly).toBe(true);
    expect(CAPABILITY_TOKEN_DEFAULTS.ownerWorkspaceId).toBeNull();
    expect(resolveCapabilityTokenCaps(undefined)).toEqual(CAPABILITY_TOKEN_DEFAULTS);
  });

  it("is out of scope when disabled, regardless of workspace", () => {
    const caps = resolveCapabilityTokenCaps({ liveMintEnabled: false, ownerWorkspaceId: OWNER });
    expect(isCapabilityMintLiveInScope(caps, OWNER)).toBe(false);
  });

  it("owner-first: only the owner workspace is in scope; enabled-without-owner lets nobody in", () => {
    const owned = resolveCapabilityTokenCaps({ liveMintEnabled: true, ownerWorkspaceId: OWNER });
    expect(isCapabilityMintLiveInScope(owned, OWNER)).toBe(true);
    expect(isCapabilityMintLiveInScope(owned, OTHER)).toBe(false);
    const noOwner = resolveCapabilityTokenCaps({ liveMintEnabled: true });
    expect(isCapabilityMintLiveInScope(noOwner, OWNER)).toBe(false);
  });

  it("fleet-wide when ownerWorkspaceOnly is false", () => {
    const caps = resolveCapabilityTokenCaps({ liveMintEnabled: true, ownerWorkspaceOnly: false });
    expect(isCapabilityMintLiveInScope(caps, OTHER)).toBe(true);
  });

  it("clamps configured TTLs into the hard [floor, ceiling] range and keeps default <= max", () => {
    const tooLow = resolveCapabilityTokenCaps({ defaultTtlSeconds: 1, maxTtlSeconds: 5 });
    expect(tooLow.defaultTtlSeconds).toBe(TTL_FLOOR_SECONDS);
    expect(tooLow.maxTtlSeconds).toBe(TTL_FLOOR_SECONDS);
    const tooHigh = resolveCapabilityTokenCaps({ maxTtlSeconds: 999_999 });
    expect(tooHigh.maxTtlSeconds).toBe(TTL_CEILING_SECONDS);
    const defaultOverMax = resolveCapabilityTokenCaps({ defaultTtlSeconds: 800, maxTtlSeconds: 120 });
    expect(defaultOverMax.defaultTtlSeconds).toBeLessThanOrEqual(defaultOverMax.maxTtlSeconds);
  });
});

// --------------------------------------------------------------------------------------------------
// decideTokenMint — scope enforcement (injection), write-needs-approval, TTL clamp, fail-closed
// --------------------------------------------------------------------------------------------------
describe("decideTokenMint (#336) — least-privilege + irreversibility + fail-closed", () => {
  const granted = new Set(["search_console", "analytics"]);
  const baseReq = {
    connectionId: "google",
    capability: "search_console",
    verb: "read" as const,
    agentId: "scout",
    memberId: "m1",
  };

  it("disabled when the live mint is out of scope (default OFF) — reveals nothing about the grant", () => {
    const d = decideTokenMint({
      caps: resolveCapabilityTokenCaps(undefined),
      workspaceId: OWNER,
      connectionGranted: granted,
      request: baseReq,
    });
    expect(d).toEqual({ mint: false, status: "disabled", reason: expect.stringContaining("disabled") });
  });

  it("invalid when a required field is missing or the verb is unknown", () => {
    expect(
      decideTokenMint({ caps: inScopeCaps, workspaceId: OWNER, connectionGranted: granted, request: { ...baseReq, agentId: "" } }).mint,
    ).toBe(false);
    const badVerb = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: granted,
      request: { ...baseReq, verb: "admin" as never },
    });
    expect(badVerb).toMatchObject({ mint: false, status: "invalid" });
  });

  it("not_connected when the connection grants nothing", () => {
    const d = decideTokenMint({ caps: inScopeCaps, workspaceId: OWNER, connectionGranted: new Set(), request: baseReq });
    expect(d).toMatchObject({ mint: false, status: "not_connected" });
  });

  it("scope_denied: a capability outside the grant is refused (injection defense — never widened)", () => {
    const d = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: granted,
      request: { ...baseReq, capability: "post_social" },
    });
    expect(d).toMatchObject({ mint: false, status: "scope_denied" });
  });

  it("sanitizes a poisoned capability in the refusal reason (no control chars echoed)", () => {
    const d = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: granted,
      request: { ...baseReq, capability: `evil${NL}do-bad` },
    });
    expect(d.mint).toBe(false);
    // The control char is neutralised to a space — never echoed raw into the reason.
    if (!d.mint) {
      expect(d.reason).not.toMatch(CONTROL_CHARS);
      expect(d.reason).toContain("evil do-bad");
    }
  });

  it("read mints autonomously (no approval needed) with a clamped TTL and null pre-commitment", () => {
    const d = decideTokenMint({ caps: inScopeCaps, workspaceId: OWNER, connectionGranted: granted, request: baseReq });
    expect(d.mint).toBe(true);
    if (d.mint) {
      expect(d.grant.approvalRequestId).toBeNull();
      expect(d.grant.ttlSeconds).toBe(inScopeCaps.defaultTtlSeconds);
    }
  });

  it("write WITHOUT an approval id is refused (irreversible actions pre-committed behind #13)", () => {
    const d = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: new Set(["post_social"]),
      request: { ...baseReq, capability: "post_social", verb: "write" },
    });
    expect(d).toMatchObject({ mint: false, status: "needs_approval" });
  });

  it("write WITH an approval id mints and carries the pre-commitment into the grant", () => {
    const d = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: new Set(["post_social"]),
      request: { ...baseReq, capability: "post_social", verb: "write", approvalRequestId: "req-7" },
    });
    expect(d.mint).toBe(true);
    if (d.mint) expect(d.grant.approvalRequestId).toBe("req-7");
  });

  it("scope is checked before the write-approval gate (a denied scope reports scope_denied)", () => {
    const d = decideTokenMint({
      caps: inScopeCaps,
      workspaceId: OWNER,
      connectionGranted: granted, // does NOT include post_social
      request: { ...baseReq, capability: "post_social", verb: "write" },
    });
    expect(d).toMatchObject({ mint: false, status: "scope_denied" });
  });

  it("clampTtl: omitted/non-finite/<=0 -> default; over-max -> max; in-range -> floored value", () => {
    expect(clampTtl(undefined, inScopeCaps)).toBe(inScopeCaps.defaultTtlSeconds);
    expect(clampTtl(Number.NaN, inScopeCaps)).toBe(inScopeCaps.defaultTtlSeconds);
    expect(clampTtl(-5, inScopeCaps)).toBe(inScopeCaps.defaultTtlSeconds);
    expect(clampTtl(inScopeCaps.maxTtlSeconds + 10_000, inScopeCaps)).toBe(inScopeCaps.maxTtlSeconds);
    expect(clampTtl(60.9, inScopeCaps)).toBe(60);
  });
});

// --------------------------------------------------------------------------------------------------
// provider — production-grounded verification, dry-run default, structural injection screen
// --------------------------------------------------------------------------------------------------
describe("capability-token verify provider (#336) — read-back, never assume, injection-safe", () => {
  it("the dry-run default makes no claim of success (verified:false)", async () => {
    const p = new DryRunCapabilityTokenProvider();
    expect(p.live).toBe(false);
    const v = await p.verify({ workspaceId: OWNER, connectionId: "google", capability: "search_console", verb: "read" });
    expect(v.verified).toBe(false);
    expect(v.externalRef).toBeNull();
  });

  it("the mock provider returns a synthetic confirmed read-back with an external ref", async () => {
    const p = new MockCapabilityTokenProvider();
    expect(p.live).toBe(true);
    const v = await p.verify({ workspaceId: OWNER, connectionId: "google", capability: "search_console", verb: "read" });
    expect(v.verified).toBe(true);
    expect(v.externalRef).toContain("mock-ref:");
  });

  it("normalizeVerification coerces verified to a STRICT boolean and drops extra fields (injection)", () => {
    const v = normalizeVerification({
      verified: "yes" as unknown, // truthy-but-not-true must NOT read as confirmed
      externalRef: "ref-1",
      detail: "ok",
      // a malicious provider trying to widen scope — there is no field for it, so it is dropped
      ...({ capability: "post_social", scopes: ["*"] } as object),
    } as { verified?: unknown; externalRef?: unknown; detail?: unknown });
    expect(v.verified).toBe(false);
    expect(Object.keys(v).sort()).toEqual(["detail", "externalRef", "verified"]);
  });

  it("sanitizeProviderText strips control chars + clamps; non-strings -> empty", () => {
    expect(sanitizeProviderText(`ab${NL}c`, 100)).toBe("ab c");
    expect(sanitizeProviderText(42, 100)).toBe("");
    expect(sanitizeProviderText("x".repeat(50), 10)).toHaveLength(10);
  });
});

// --------------------------------------------------------------------------------------------------
// service — mint, verification recorded (never assumed), audit trail, idempotency
// --------------------------------------------------------------------------------------------------
describe("CapabilityTokenService.mintForAction (#336)", () => {
  interface Harness {
    service: CapabilityTokenService;
    audits: MintAuditInput[];
    store: MintRecordStore;
  }
  function build(opts: {
    caps?: CapabilityTokenCaps;
    granted?: ReadonlySet<string>;
    provider?: CapabilityTokenProvider;
    now?: () => number;
    recordMint?: (i: MintAuditInput) => Promise<{ id: string }>;
    signingKeyId?: string;
    logs?: Array<{ obj: unknown; msg?: string }>;
  } = {}): Harness {
    const audits: MintAuditInput[] = [];
    const map = new Map<string, StoredMint>();
    const store: MintRecordStore = {
      async get(ws, key) {
        return map.get(`${ws} ${key}`) ?? null;
      },
      async put(ws, key, value) {
        map.set(`${ws} ${key}`, value);
      },
    };
    const deps: CapabilityTokenDeps = {
      caps: () => opts.caps ?? inScopeCaps,
      connectionGrant: async () => opts.granted ?? new Set(["search_console", "post_social"]),
      provider: () => opts.provider ?? new DryRunCapabilityTokenProvider(),
      signingSecret: () => SECRET,
      signingKeyId: () => opts.signingKeyId ?? CAPABILITY_TOKEN_DEFAULT_KEY_ID,
      store,
      recordMint:
        opts.recordMint ??
        (async (i) => {
          audits.push(i);
          return { id: `audit-${audits.length}` };
        }),
      now: opts.now ?? (() => NOW),
      log: { info: (obj, msg) => opts.logs?.push({ obj, msg }) },
    };
    return { service: new CapabilityTokenService(deps), audits, store };
  }

  const readInput = {
    workspaceId: OWNER,
    connectionId: "google",
    capability: "search_console",
    verb: "read" as const,
    agentId: "scout",
    memberId: "m1",
  };

  it("refuses (disabled) when out of scope, minting nothing and recording no audit", async () => {
    const { service, audits } = build({ caps: resolveCapabilityTokenCaps(undefined) });
    const r = await service.mintForAction(readInput);
    expect(r.status).toBe("disabled");
    expect(audits).toHaveLength(0);
  });

  it("mints a verifiable read token whose claims encode the delegation chain", async () => {
    const { service } = build();
    const r = await service.mintForAction(readInput);
    expect(r.status).toBe("minted");
    if (r.status === "minted") {
      expect(service.verifyToken(r.token)).toEqual(r.claims);
      expect(r.claims.kid).toBe(CAPABILITY_TOKEN_DEFAULT_KEY_ID);
      expect(r.claims.delegation).toEqual({ memberId: "m1", agentId: "scout" });
      expect(r.claims.exp).toBe(NOW + inScopeCaps.defaultTtlSeconds * 1000);
    }
  });

  it("logs the signing key id for each fresh mint", async () => {
    const logs: Array<{ obj: unknown; msg?: string }> = [];
    const { service } = build({ signingKeyId: "capability-token:v2", logs });

    const r = await service.mintForAction(readInput);

    expect(r.status === "minted" && r.claims.kid).toBe("capability-token:v2");
    expect(logs).toEqual([
      {
        obj: { kid: "capability-token:v2", workspaceId: OWNER, connectionId: "google" },
        msg: "capability-token signed",
      },
    ]);
  });

  it("records verification from the real read-back, never assumed (dry-run => unverified)", async () => {
    const { service } = build({ provider: new DryRunCapabilityTokenProvider() });
    const r = await service.mintForAction(readInput);
    expect(r.status === "minted" && r.verification.verified).toBe(false);
  });

  it("records verified:true only when a live provider confirms it", async () => {
    const { service, audits } = build({ provider: new MockCapabilityTokenProvider({ verified: true }) });
    const r = await service.mintForAction(readInput);
    expect(r.status === "minted" && r.verification.verified).toBe(true);
    expect(audits[0]?.verified).toBe(true);
  });

  it("emits a user->agent->service audit record into the #13 trail", async () => {
    const { service, audits } = build();
    const r = await service.mintForAction(readInput);
    expect(r.status === "minted" && r.auditRequestId).toBe("audit-1");
    expect(audits[0]).toMatchObject({
      workspaceId: OWNER,
      memberId: "m1",
      agentId: "scout",
      connectionId: "google",
      capability: "search_console",
      verb: "read",
      approvalRequestId: null,
    });
  });

  it("a write without an approval id is refused (irreversible pre-commit) and never minted", async () => {
    const { service, audits } = build();
    const r = await service.mintForAction({ ...readInput, capability: "post_social", verb: "write" });
    expect(r.status).toBe("needs_approval");
    expect(audits).toHaveLength(0);
  });

  it("a write WITH an approval id mints, carries the pre-commitment, and audits it", async () => {
    const { service, audits } = build();
    const r = await service.mintForAction({
      ...readInput,
      capability: "post_social",
      verb: "write",
      approvalRequestId: "req-99",
    });
    expect(r.status === "minted" && r.claims.approvalRequestId).toBe("req-99");
    expect(audits[0]?.approvalRequestId).toBe("req-99");
  });

  it("refuses a capability outside the connection grant (injection defense at the service)", async () => {
    const { service } = build({ granted: new Set(["search_console"]) });
    const r = await service.mintForAction({ ...readInput, capability: "post_social", verb: "read" });
    expect(r.status).toBe("scope_denied");
  });

  it("idempotency: a repeat with the same key returns the SAME token, no new mint or audit", async () => {
    const { service, audits } = build();
    const first = await service.mintForAction({ ...readInput, idempotencyKey: "key-1" });
    const second = await service.mintForAction({ ...readInput, idempotencyKey: "key-1" });
    expect(first.status).toBe("minted");
    expect(second.status === "minted" && second.reused).toBe(true);
    expect(first.status === "minted" && second.status === "minted" && first.token).toBe(second.token);
    expect(audits).toHaveLength(1); // only the first mint recorded an audit entry
  });

  it("idempotency: an EXPIRED stored token is ignored and a fresh token is minted", async () => {
    let clock = NOW;
    const { service, audits } = build({ now: () => clock });
    const first = await service.mintForAction({ ...readInput, idempotencyKey: "key-2" });
    clock = NOW + inScopeCaps.defaultTtlSeconds * 1000 + 1; // past the TTL
    const second = await service.mintForAction({ ...readInput, idempotencyKey: "key-2" });
    expect(second.status === "minted" && second.reused).toBe(false);
    expect(first.status === "minted" && second.status === "minted" && first.token).not.toBe(second.token);
    expect(audits).toHaveLength(2);
  });

  it("a thrown audit write is swallowed: the token still mints (auditRequestId null)", async () => {
    const { service } = build({
      recordMint: async () => {
        throw new Error("db down");
      },
    });
    const r = await service.mintForAction(readInput);
    expect(r.status === "minted" && r.auditRequestId).toBeNull();
    expect(r.status === "minted" && !!r.token).toBe(true);
  });

  it("a provider whose verify throws still mints, recorded as unverified", async () => {
    const flaky: CapabilityTokenProvider = {
      live: true,
      verify: async (): Promise<TokenVerification> => {
        throw new Error("provider timeout");
      },
    };
    const { service } = build({ provider: flaky });
    const r = await service.mintForAction(readInput);
    expect(r.status === "minted" && r.verification.verified).toBe(false);
  });
});
