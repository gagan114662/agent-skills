import { createHash } from "node:crypto";

/**
 * The connect-once PROVIDER adapter seam (#258 Stage 2, ADR-0258). This is the reusable surface the
 * per-department follow-ups build on: Google Search Console for Scout (#265), an ESP for Postmark (#268), a
 * social aggregator for Echo (#269), an ad account for Bid (#272). Each registers ONE provider behind this
 * interface and the gated connect FLOW, vault seal, and capability resolution all work unchanged.
 *
 * A provider does exactly two things: build the consent URL the user is redirected to, and exchange the
 * callback `code` for the credential to seal + the capabilities it unlocks. Honoring the premortem (#200):
 *  - §3 production-grounded: NOTHING real is minted unless a provider is `live` AND returns a credential.
 *    The default {@link DryRunConnectProvider} never mints — so an unwired deployment degrades honestly to
 *    `coming_soon`, never a fake "connected". {@link MockConnectProvider} is a TEST/DEMO double; it returns
 *    a clearly synthetic, non-secret placeholder (never a real credential) and makes no network call.
 *  - §6 injection defense: the callback `code`/`state` are UNTRUSTED. {@link isValidAuthCode} rejects
 *    anything that is not a bare URL-safe code before it can reach a token exchange; the HMAC state (see
 *    `state.ts`) binds the callback to its originating workspace + connection.
 */

/** The result of a successful consent exchange: the capabilities granted + the secrets to seal. */
export interface ConnectExchangeResult {
  /**
   * The real-world capabilities this consent unlocks (e.g. `search_console`, `post_social`). Downstream
   * agents read these (via the vault `scopes`) to decide what they may do — see `capabilities.ts`. A live
   * provider derives them from the granted scopes; an empty array means nothing was actually granted.
   */
  capabilities: string[];
  /**
   * The env-var → value map sealed into the #192 vault under the connection's `service_key`. The agents
   * resolve these via `resolveServiceSecrets(workspaceId, connectionId)`. Empty ⇒ nothing to seal (the
   * connect did not produce a usable credential), so the seam must NOT mark the connection connected.
   */
  secrets: Record<string, string>;
}

/** An exchange that minted nothing usable — the honest "no credential" result (never seals a blank). */
export const EMPTY_EXCHANGE: ConnectExchangeResult = { capabilities: [], secrets: {} };

export interface ConnectProvider {
  /** Whether this provider can mint a real credential. The route reads it to offer `available` vs `coming_soon`. */
  readonly live: boolean;
  /** Build the consent URL the user is redirected to (the redirect URI is provider-internal config). */
  authorizeUrl(input: { state: string }): string;
  /** Exchange the callback `code` for the credential + granted capabilities ({@link EMPTY_EXCHANGE} on none). */
  exchange(input: { code: string; state: string }): Promise<ConnectExchangeResult>;
}

/** A small error so the route can map a provider failure to a friendly redirect instead of a 500. */
export class ConnectProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectProviderError";
  }
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
// The dry-run default — never mints. An unwired deployment degrades honestly to `coming_soon`.
// ---------------------------------------------------------------------------------------------------

export class DryRunConnectProvider implements ConnectProvider {
  readonly live = false;
  authorizeUrl(): string {
    // A deliberately non-navigable sentinel so a dry-run start can never bounce a user to a real IdP.
    return "about:blank#connect-once-dry-run";
  }
  async exchange(): Promise<ConnectExchangeResult> {
    return EMPTY_EXCHANGE;
  }
}

// ---------------------------------------------------------------------------------------------------
// The mock provider — a TEST/DEMO double. Returns a clearly synthetic, non-secret placeholder so the seal
// + capability path is exercisable end-to-end WITHOUT a real provider account or any network call. It is
// never selected by {@link createConnectProvider}; tests/demos construct it explicitly.
// ---------------------------------------------------------------------------------------------------

export class MockConnectProvider implements ConnectProvider {
  readonly live = true;
  constructor(
    private readonly opts: {
      connectionId: string;
      /** The capabilities a successful mock consent grants (the descriptor's capabilities). */
      capabilities: readonly string[];
      /** Env-var keys to seal a synthetic placeholder under (so a connector's read path is testable). */
      secretKeys?: readonly string[];
    },
  ) {}

  authorizeUrl(input: { state: string }): string {
    // Points back at a mock callback so a demo flow round-trips without a real IdP. Never a real consent URL.
    return `https://mock.connect.local/${this.opts.connectionId}/authorize?state=${encodeURIComponent(input.state)}`;
  }

  async exchange(): Promise<ConnectExchangeResult> {
    const secretKeys = this.opts.secretKeys ?? [`${this.opts.connectionId.toUpperCase()}_MOCK_TOKEN`];
    const secrets: Record<string, string> = {};
    // A clearly-synthetic, non-secret placeholder — NEVER a real credential.
    for (const key of secretKeys) secrets[key] = `mock:${this.opts.connectionId}`;
    return { capabilities: [...this.opts.capabilities], secrets };
  }
}

// ---------------------------------------------------------------------------------------------------
// A generic live OAuth provider — standard OAuth 2.0 authorization-code exchange, no SDK. A per-department
// follow-up (#265/#268/#269/#272) constructs one with its provider's endpoints + a token→credential mapper.
// `createConnectProvider` returns it ONLY when a live client is configured, else the dry-run default — so an
// unwired deployment (every deployment until a follow-up wires a real client) stays honest `coming_soon`.
// ---------------------------------------------------------------------------------------------------

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scopes: readonly string[];
  tokenAuth?: "client_secret_post" | "basic";
  tokenMethod?: "POST" | "GET";
  pkce?: {
    secret: string;
    method: "S256";
  };
  authorizeParams?: Record<string, string>;
}

/**
 * Map a token response to {@link ConnectExchangeResult}. Injected per-provider so the generic exchange
 * stays provider-agnostic. Returns {@link EMPTY_EXCHANGE} when the response carries no usable credential —
 * so a malformed/empty response can never seal a blank credential into the vault.
 */
export type TokenResponseMapper = (json: unknown) => ConnectExchangeResult;

export class OAuthConnectProvider implements ConnectProvider {
  readonly live = true;
  constructor(
    private readonly config: OAuthClientConfig,
    private readonly mapTokens: TokenResponseMapper,
  ) {}

  authorizeUrl(input: { state: string }): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: this.config.scopes.join(" "),
      state: input.state,
    });
    if (this.config.pkce) {
      params.set("code_challenge", pkceChallenge(pkceVerifier(input.state, this.config.pkce.secret)));
      params.set("code_challenge_method", this.config.pkce.method);
    }
    for (const [key, value] of Object.entries(this.config.authorizeParams ?? {})) {
      params.set(key, value);
    }
    return `${this.config.authorizeUrl}?${params.toString()}`;
  }

  async exchange(input: { code: string; state: string }): Promise<ConnectExchangeResult> {
    const body = new URLSearchParams({
      code: input.code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (this.config.pkce) body.set("code_verifier", pkceVerifier(input.state, this.config.pkce.secret));
    if (this.config.tokenAuth === "basic") {
      headers.authorization = `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`, "utf8").toString("base64")}`;
    } else {
      body.set("client_secret", this.config.clientSecret);
    }
    const method = this.config.tokenMethod ?? "POST";
    const tokenUrl = new URL(this.config.tokenUrl);
    const requestInit: RequestInit =
      method === "GET"
        ? { method }
        : {
            method,
            headers,
            body,
          };
    if (method === "GET") {
      for (const [key, value] of body.entries()) tokenUrl.searchParams.set(key, value);
    }
    try {
      const res = await fetch(method === "GET" ? tokenUrl.toString() : this.config.tokenUrl, requestInit);
      if (!res.ok) throw new ConnectProviderError(`token exchange returned ${res.status}`);
      return this.mapTokens(await res.json());
    } catch (err) {
      if (err instanceof ConnectProviderError) throw err;
      throw new ConnectProviderError(`token exchange failed: ${(err as Error).message}`);
    }
  }
}

function pkceVerifier(state: string, secret: string): string {
  return createHash("sha256").update(`${state}.${secret}`).digest("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Pick the provider for a connection: a live {@link OAuthConnectProvider} when a full OAuth client is
 * supplied, else the dry-run default. Returning the same provider the route reads `provider.live` from means
 * the offer (`available` vs `coming_soon`) and what actually happens can never disagree. No live client is
 * wired in this slice, so every real deployment resolves to the dry-run default (honest `coming_soon`) — the
 * per-department follow-ups supply a real client behind the same call.
 */
export function createConnectProvider(input: {
  client: OAuthClientConfig | null;
  mapTokens: TokenResponseMapper;
}): ConnectProvider {
  return input.client ? new OAuthConnectProvider(input.client, input.mapTokens) : new DryRunConnectProvider();
}
