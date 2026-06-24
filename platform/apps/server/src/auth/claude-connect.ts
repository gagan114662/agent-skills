import { createHmac, timingSafeEqual } from "node:crypto";
import { isTransientHttpStatus, retryWithBackoff } from "../reliability/retry-backoff.js";
import type { ConnectClaudeConfig } from "../config/schema.js";

/**
 * Connect Claude without a CLI token (#262, ADR-0262).
 *
 * Today the only way to enable the fleet is to run `claude setup-token` in a terminal and paste the
 * result into Settings — impossible for a non-technical user. This module is the pure half of the
 * in-app, one-click "Connect Claude" replacement: an OAuth-shaped consent (no terminal, no paste) that
 * seals the resulting subscription token into the SAME per-tenant #68 vault the manual paste already
 * uses (`workspace_agent_credentials`), so the runtime auth path (#246 subscription-only) is unchanged.
 *
 * Honoring the premortem (#200):
 *  - §3 production-grounded: NOTHING real is minted unless a live OAuth client is configured AND the
 *    provider returns a token. The default {@link DryRunClaudeConnectProvider} never mints — so an
 *    unwired deployment degrades honestly to `coming_soon`, never a fake "connected".
 *  - §4 reversibility: connecting is reversible (disconnect clears the vault) and is CONSENT, not money —
 *    so it carries no #13 gate (consistent with #243 money-only and the #258 non-money connects).
 *  - §6 injection defense: the OAuth callback `code`/`state` are UNTRUSTED. {@link isValidAuthCode}
 *    rejects anything that isn't a bare URL-safe code before it can reach a token exchange, and the
 *    HMAC {@link verifyConnectState} binds the callback to the originating workspace (anti-CSRF +
 *    anti-tenant-cross) with no server-side session table.
 *
 * Default OFF + owner-workspace-first ({@link CONNECT_CLAUDE_DEFAULTS}): a deployment that sets nothing
 * keeps today's paste path (behind the #263 Advanced disclosure), which always stays available so a
 * workspace is never left unable to connect.
 */

/** Service key for the Claude connect consent (the #68 vault is keyed by workspace; this names the flow). */
export const CLAUDE_CONNECT_SERVICE_KEY = "claude";

// ---------------------------------------------------------------------------------------------------
// Policy (#58 layered config) — default OFF, owner-workspace-first. Mirrors `agent-registry/caps.ts`.
// ---------------------------------------------------------------------------------------------------

export interface ConnectClaudeCaps {
  /** The managed one-click connect flag — default OFF (the manual paste path always remains). */
  enabled: boolean;
  /** Restrict the managed flow to the owner workspace first (default true). */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id (owner-first rollout marker), or null. */
  ownerWorkspaceId: string | null;
}

export const CONNECT_CLAUDE_DEFAULTS: ConnectClaudeCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
};

export function resolveConnectClaudeCaps(cfg: ConnectClaudeConfig | undefined): ConnectClaudeCaps {
  const d = CONNECT_CLAUDE_DEFAULTS;
  return {
    enabled: cfg?.enabled ?? d.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? d.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? d.ownerWorkspaceId,
  };
}

/**
 * Is the managed one-click connect in scope for this workspace? Pure + total + fail-closed: disabled ⇒
 * never; owner-first ⇒ ONLY the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody
 * in, never everybody).
 */
export function isConnectClaudeInScope(caps: ConnectClaudeCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}

// ---------------------------------------------------------------------------------------------------
// The offer the UI renders.
// ---------------------------------------------------------------------------------------------------

/** `managed_oauth` = the one-click button; `paste_token` = today's Advanced setup-token paste. */
export type ClaudeConnectMethod = "managed_oauth" | "paste_token";
/** `available` = the method works now; `coming_soon` = featured but not wired (honest). */
export type ClaudeConnectStatus = "available" | "coming_soon";

export interface ClaudeConnectOffer {
  /** The PRIMARY/featured connect method — the manual paste stays available via Advanced regardless. */
  method: ClaudeConnectMethod;
  /** True iff the one-click managed flow is the featured path for this workspace. */
  managed: boolean;
  status: ClaudeConnectStatus;
  /** A short, user-facing reason (e.g. why it's coming soon), or null when nothing to explain. */
  reason: string | null;
}

/**
 * Decide what the Connect Claude panel should feature. When the managed flow is out of scope (flag off
 * or not the owner workspace) the workspace gets today's paste path. When in scope, the one-click flow
 * is featured — `available` if a live OAuth client is configured, else an honest `coming_soon` (with the
 * paste path still available behind Advanced).
 */
export function decideClaudeConnectOffer(input: {
  caps: ConnectClaudeCaps;
  workspaceId: string;
  liveProviderConfigured: boolean;
}): ClaudeConnectOffer {
  if (!isConnectClaudeInScope(input.caps, input.workspaceId)) {
    return {
      method: "paste_token",
      managed: false,
      status: "available",
      reason: null,
    };
  }
  if (!input.liveProviderConfigured) {
    return {
      method: "managed_oauth",
      managed: true,
      status: "coming_soon",
      reason: "One-click Connect is rolling out — you can paste a setup token under Advanced for now.",
    };
  }
  return { method: "managed_oauth", managed: true, status: "available", reason: null };
}

// ---------------------------------------------------------------------------------------------------
// Injection defense (#200 §6) — the OAuth callback inputs are untrusted.
// ---------------------------------------------------------------------------------------------------

/** Max length we'll accept for an OAuth authorization code (generous; real codes are far shorter). */
const MAX_AUTH_CODE_LEN = 4096;
/** OAuth authorization codes are URL-safe per RFC 6749 — restrict to that charset, nothing else. */
const AUTH_CODE_RE = /^[A-Za-z0-9._~-]+$/;

/**
 * True iff `code` is a bare, URL-safe OAuth authorization code. A poisoned callback (extra query params,
 * path traversal, whitespace, CRLF, markup) is rejected here BEFORE it could ever be interpolated into a
 * token-exchange request — a read of an attacker-controlled redirect can never steer the exchange.
 */
export function isValidAuthCode(code: unknown): code is string {
  return (
    typeof code === "string" &&
    code.length > 0 &&
    code.length <= MAX_AUTH_CODE_LEN &&
    AUTH_CODE_RE.test(code)
  );
}

// ---------------------------------------------------------------------------------------------------
// OAuth `state` — HMAC-signed, no DB. Binds the callback to its originating workspace (CSRF + tenant).
// Mirrors the #260 `oauth-state` shape but carries `{workspaceId, nonce}` instead of a domain.
// ---------------------------------------------------------------------------------------------------

export interface ConnectStatePayload {
  workspaceId: string;
  nonce: string;
}

interface SignedConnectState extends ConnectStatePayload {
  ts: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Encode + sign a connect state. `now` is injected so it unit-tests deterministically. */
export function signConnectState(
  payload: ConnectStatePayload,
  secret: string,
  now: number = Date.now(),
): string {
  const signed: SignedConnectState = { workspaceId: payload.workspaceId, nonce: payload.nonce, ts: now };
  const body = Buffer.from(JSON.stringify(signed), "utf8").toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify + decode a connect state: returns the payload when the signature matches and the state is
 * younger than `maxAgeMs`; null otherwise (tampered, malformed, wrong secret, expired, or future-dated).
 */
export function verifyConnectState(
  state: string,
  secret: string,
  opts: { maxAgeMs?: number; now?: number } = {},
): ConnectStatePayload | null {
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60 * 1000; // a consent screen is short-lived
  const now = opts.now ?? Date.now();
  if (typeof state !== "string" || !state.includes(".")) return null;
  const dot = state.indexOf(".");
  const body = state.slice(0, dot);
  const mac = state.slice(dot + 1);
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(sign(body, secret));
  if (macBuf.length !== expBuf.length || !timingSafeEqual(macBuf, expBuf)) return null;
  let parsed: SignedConnectState;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedConnectState;
  } catch {
    return null;
  }
  // A correctly-signed body can still decode to `null`, a primitive, or an array — guard BEFORE any
  // property access so an attacker-crafted payload returns null instead of throwing (crashing the callback).
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof parsed.workspaceId !== "string" || typeof parsed.nonce !== "string") return null;
  if (typeof parsed.ts !== "number" || now - parsed.ts > maxAgeMs || parsed.ts > now + 60_000) {
    return null;
  }
  return { workspaceId: parsed.workspaceId, nonce: parsed.nonce };
}

// ---------------------------------------------------------------------------------------------------
// Live OAuth client config (env-driven, OFF when unset) + pure URL/response helpers.
// The live client id/endpoints come from a registered OAuth app — never hardcoded here, never a secret
// in layered config. Unset ⇒ null ⇒ the feature is `coming_soon` and the dry-run provider is used.
// ---------------------------------------------------------------------------------------------------

/**
 * Default scopes requested in the consent. The authoritative values come from the registered Anthropic
 * OAuth app at wire-up time; these are a safe, minimal placeholder so the pure URL builder is testable.
 */
export const CLAUDE_OAUTH_DEFAULT_SCOPES: readonly string[] = ["user:inference", "user:profile"];

export interface ClaudeOAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
}

/** Load the deployment-wide Claude OAuth app config from env, or null when not fully configured. */
export function loadClaudeOAuthConfig(env: NodeJS.ProcessEnv = process.env): ClaudeOAuthConfig | null {
  const clientId = env.CLAUDE_OAUTH_CLIENT_ID?.trim();
  const authorizeUrl = env.CLAUDE_OAUTH_AUTHORIZE_URL?.trim();
  const tokenUrl = env.CLAUDE_OAUTH_TOKEN_URL?.trim();
  const redirectUri = env.CLAUDE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !authorizeUrl || !tokenUrl || !redirectUri) return null;
  return { clientId, authorizeUrl, tokenUrl, redirectUri };
}

/** Build the consent URL for the authorization-code flow. */
export function buildClaudeAuthorizeUrl(input: {
  config: ClaudeOAuthConfig;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? CLAUDE_OAUTH_DEFAULT_SCOPES).join(" "),
    state: input.state,
  });
  return `${input.config.authorizeUrl}?${params.toString()}`;
}

/**
 * Map an OAuth token response to the subscription token, or null when the response carries no usable
 * token — so a malformed/empty response can never seal a blank credential into the vault.
 */
export function mapClaudeTokenResponse(json: unknown): { token: string | null } {
  if (json === null || typeof json !== "object") return { token: null };
  const raw = (json as { access_token?: unknown }).access_token;
  const token = typeof raw === "string" ? raw.trim() : "";
  return { token: token.length > 0 ? token : null };
}

// ---------------------------------------------------------------------------------------------------
// Provider seam — the dry-run default never mints a real token. A live provider is wired only when an
// OAuth client is configured (the follow-up), so today's deployments stay byte-for-byte unchanged.
// ---------------------------------------------------------------------------------------------------

export interface ClaudeConnectProvider {
  /** Whether this provider can mint a real subscription token. */
  readonly live: boolean;
  /** Build the consent URL the owner is redirected to (the redirect URI is provider-internal config). */
  authorizeUrl(input: { state: string }): string;
  /** Exchange the callback `code` for a subscription token (null when nothing real was minted). */
  exchange(input: { code: string; state: string }): Promise<{ token: string | null }>;
}

/** The default provider: not live, never mints a token — the feature degrades to an honest coming-soon. */
export class DryRunClaudeConnectProvider implements ClaudeConnectProvider {
  readonly live = false;
  authorizeUrl(): string {
    // A deliberately non-navigable sentinel so a dry-run start can never bounce a user to a real IdP.
    return "about:blank#claude-connect-dry-run";
  }
  async exchange(): Promise<{ token: string | null }> {
    return { token: null };
  }
}

/** A small error so the route can map a Claude OAuth failure to a friendly redirect instead of a 500. */
export class ClaudeConnectError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "ClaudeConnectError";
    this.status = options?.status;
  }
}

function shouldRetryClaudeConnectError(err: unknown): boolean {
  if (!(err instanceof ClaudeConnectError)) return true;
  return err.status === undefined || isTransientHttpStatus(err.status);
}

/**
 * The live provider — constructed ONLY when a real OAuth client is configured (see
 * {@link createClaudeConnectProvider}). Standard OAuth 2.0 authorization-code exchange, no SDK. The
 * `code` is validated by {@link isValidAuthCode} at the route boundary before it ever reaches here.
 */
export class LiveClaudeConnectProvider implements ClaudeConnectProvider {
  readonly live = true;
  constructor(private readonly config: ClaudeOAuthConfig) {}

  authorizeUrl(input: { state: string }): string {
    return buildClaudeAuthorizeUrl({ config: this.config, state: input.state });
  }

  async exchange(input: { code: string; state: string }): Promise<{ token: string | null }> {
    const body = new URLSearchParams({
      code: input.code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });
    try {
      return await retryWithBackoff(
        async () => {
          const res = await fetch(this.config.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body,
          });
          if (!res.ok) {
            throw new ClaudeConnectError(`token exchange returned ${res.status}`, { status: res.status });
          }
          return mapClaudeTokenResponse(await res.json());
        },
        { maxAttempts: 3, baseDelayMs: 50, shouldRetry: shouldRetryClaudeConnectError },
      );
    } catch (err) {
      if (err instanceof ClaudeConnectError) throw err;
      throw new ClaudeConnectError(`token exchange failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Pick the connect provider for a deployment: the live one when a full OAuth client is configured in env,
 * else the dry-run default. The route reads `provider.live` to decide whether the one-click flow is
 * `available` or an honest `coming_soon` — so the offer and what actually happens can never disagree.
 */
export function createClaudeConnectProvider(env: NodeJS.ProcessEnv = process.env): ClaudeConnectProvider {
  const config = loadClaudeOAuthConfig(env);
  return config ? new LiveClaudeConnectProvider(config) : new DryRunClaudeConnectProvider();
}
