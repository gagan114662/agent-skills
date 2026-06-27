/**
 * Production wiring for the connect-once service (#258 Stage 2, ADR-0258). Binds the pure service to real
 * seams:
 *
 *   - `caps` — the layered #58 config (`connectOnce` block → `resolveConnectOnceCaps`). Default OFF,
 *     owner-workspace-first.
 *   - `provider` — dry-run by default for every connection. Google is the first live OAuth candidate: it
 *     becomes live only when the deployment has the Google client id/secret AND a dedicated connection
 *     redirect URI. Everything else stays honest `coming_soon` until its real provider is wired.
 *   - `park` — parks a PENDING `connection.connect_account` #13 request (a CONSENT the owner gates; recorded
 *     -only on approval). There is no autonomous-connect path.
 */
import { createRequest } from "../db/repositories/approvals.js";
import { loadConfig } from "../config/loader.js";
import { CONNECTION_CONNECT_ACCOUNT_ACTION } from "../approvals/policy.js";
import { GOOGLE_ANALYTICS_SCOPE, GOOGLE_SEARCH_CONSOLE_SCOPE } from "../auth/google-oauth.js";
import {
  googleConnectionOAuthConfigStatus,
  resolveGoogleConnectionRedirectUri,
} from "./google-oauth-config.js";
import {
  googleAdsConnectionOAuthConfigStatus,
  resolveGoogleAdsConnectionRedirectUri,
} from "./google-ads-oauth-config.js";
import { xConnectionOAuthConfigStatus } from "./x-oauth-config.js";
import { resolveConnectOnceCaps } from "./caps.js";
import {
  createConnectProvider,
  EMPTY_EXCHANGE,
  type ConnectExchangeResult,
  type ConnectProvider,
  type OAuthClientConfig,
} from "./provider.js";
import { ConnectOnceService, type ConnectOnceDeps } from "./service.js";

export { googleConnectionOAuthConfigStatus } from "./google-oauth-config.js";
export { googleAdsConnectionOAuthConfigStatus } from "./google-ads-oauth-config.js";
export { xConnectionOAuthConfigStatus } from "./x-oauth-config.js";

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

/**
 * The provider wired for a connection id. Dry-run is still the default, but Google can become live when the
 * deployment supplies a dedicated connection OAuth redirect URI. We deliberately do NOT reuse the public
 * sign-in callback URI: a connection callback seals tenant credentials, while sign-in creates a session.
 */
export function defaultConnectProvider(
  connectionId: string,
  env: NodeJS.ProcessEnv = process.env,
): ConnectProvider {
  if (connectionId === "google") {
    return createConnectProvider({
      client: loadGoogleConnectionClient(env),
      mapTokens: mapGoogleConnectionTokens,
    });
  }
  if (connectionId === "x") {
    return createConnectProvider({
      client: loadXConnectionClient(env),
      mapTokens: mapXConnectionTokens,
    });
  }
  if (connectionId === "google_ads") {
    return createConnectProvider({
      client: loadGoogleAdsConnectionClient(env),
      mapTokens: mapGoogleAdsConnectionTokens,
    });
  }
  return createConnectProvider({ client: null, mapTokens: () => EMPTY_EXCHANGE });
}

function loadGoogleConnectionClient(env: NodeJS.ProcessEnv): OAuthClientConfig | null {
  if (!googleConnectionOAuthConfigStatus(env).configured) return null;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = resolveGoogleConnectionRedirectUri(env);
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE, GOOGLE_ANALYTICS_SCOPE],
  };
}

function mapGoogleConnectionTokens(json: unknown): ConnectExchangeResult {
  const token = json as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    token_type?: unknown;
  };
  if (typeof token.access_token !== "string" || !token.access_token.trim()) return EMPTY_EXCHANGE;
  const scope = typeof token.scope === "string" ? token.scope : "";
  const scopes = scope.split(/\s+/).filter(Boolean);
  const secrets: Record<string, string> = {
    GOOGLE_OAUTH_ACCESS_TOKEN: token.access_token,
    GOOGLE_OAUTH_SCOPE: scope || [GOOGLE_SEARCH_CONSOLE_SCOPE, GOOGLE_ANALYTICS_SCOPE].join(" "),
    GOOGLE_OAUTH_TOKEN_TYPE: typeof token.token_type === "string" ? token.token_type : "Bearer",
  };
  if (typeof token.refresh_token === "string" && token.refresh_token.trim()) {
    secrets.GOOGLE_OAUTH_REFRESH_TOKEN = token.refresh_token;
  }
  if (typeof token.expires_in === "number" && Number.isFinite(token.expires_in)) {
    secrets.GOOGLE_OAUTH_EXPIRES_AT = String(Date.now() + token.expires_in * 1000);
  }
  const capabilities = [
    ...(scopes.includes(GOOGLE_SEARCH_CONSOLE_SCOPE) ? ["search_console"] : []),
    ...(scopes.includes(GOOGLE_ANALYTICS_SCOPE) ? ["analytics"] : []),
  ];
  return { capabilities, secrets };
}

function loadXConnectionClient(env: NodeJS.ProcessEnv): OAuthClientConfig | null {
  if (!xConnectionOAuthConfigStatus(env).configured) return null;
  const clientId = env.X_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.X_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.X_CONNECTION_OAUTH_REDIRECT_URI?.trim();
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    tokenAuth: "basic",
    pkce: { method: "S256", secret: clientSecret! },
  };
}

function mapXConnectionTokens(json: unknown): ConnectExchangeResult {
  const token = json as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    token_type?: unknown;
  };
  if (typeof token.access_token !== "string" || !token.access_token.trim()) return EMPTY_EXCHANGE;
  const scope = typeof token.scope === "string" ? token.scope : "tweet.read tweet.write users.read offline.access";
  const secrets: Record<string, string> = {
    X_OAUTH_ACCESS_TOKEN: token.access_token,
    X_OAUTH_SCOPE: scope,
    X_OAUTH_TOKEN_TYPE: typeof token.token_type === "string" ? token.token_type : "Bearer",
  };
  if (typeof token.refresh_token === "string" && token.refresh_token.trim()) {
    secrets.X_OAUTH_REFRESH_TOKEN = token.refresh_token;
  }
  if (typeof token.expires_in === "number" && Number.isFinite(token.expires_in)) {
    secrets.X_OAUTH_EXPIRES_AT = String(Date.now() + token.expires_in * 1000);
  }
  const scopes = scope.split(/\s+/).filter(Boolean);
  return {
    capabilities: scopes.includes("tweet.write") && scopes.includes("users.read") ? ["post_social"] : [],
    secrets,
  };
}

function loadGoogleAdsConnectionClient(env: NodeJS.ProcessEnv): OAuthClientConfig | null {
  if (!googleAdsConnectionOAuthConfigStatus(env).configured) return null;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = resolveGoogleAdsConnectionRedirectUri(env);
  return {
    clientId: clientId!,
    clientSecret: clientSecret!,
    redirectUri: redirectUri!,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [GOOGLE_ADS_SCOPE],
    authorizeParams: { access_type: "offline", prompt: "consent" },
  };
}

function mapGoogleAdsConnectionTokens(json: unknown): ConnectExchangeResult {
  const token = json as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    token_type?: unknown;
  };
  if (typeof token.access_token !== "string" || !token.access_token.trim()) return EMPTY_EXCHANGE;
  const scope = typeof token.scope === "string" ? token.scope : GOOGLE_ADS_SCOPE;
  const secrets: Record<string, string> = {
    GOOGLE_ADS_OAUTH_ACCESS_TOKEN: token.access_token,
    GOOGLE_ADS_OAUTH_SCOPE: scope,
    GOOGLE_ADS_OAUTH_TOKEN_TYPE: typeof token.token_type === "string" ? token.token_type : "Bearer",
  };
  if (typeof token.refresh_token === "string" && token.refresh_token.trim()) {
    secrets.GOOGLE_ADS_OAUTH_REFRESH_TOKEN = token.refresh_token;
  }
  if (typeof token.expires_in === "number" && Number.isFinite(token.expires_in)) {
    secrets.GOOGLE_ADS_OAUTH_EXPIRES_AT = String(Date.now() + token.expires_in * 1000);
  }
  const scopes = scope.split(/\s+/).filter(Boolean);
  return {
    capabilities: scopes.includes(GOOGLE_ADS_SCOPE) ? ["ads"] : [],
    secrets,
  };
}

/** Build the production-wired connect-once service. */
export function createDefaultConnectOnceService(): ConnectOnceService {
  const deps: ConnectOnceDeps = {
    caps: (workspaceId) => resolveConnectOnceCaps(loadConfig(workspaceId).connectOnce),
    provider: (connectionId) => defaultConnectProvider(connectionId),
    park: async (input) => {
      const req = await createRequest({
        workspaceId: input.workspaceId,
        requesterMemberId: input.requesterMemberId,
        actionType: CONNECTION_CONNECT_ACCOUNT_ACTION,
        payload: {
          connectionId: input.descriptor.id,
          provider: input.descriptor.provider,
          capabilities: input.descriptor.capabilities,
          oauthScopes: input.descriptor.oauthScopes,
        },
        amount: null,
        summary: `Connect ${input.descriptor.label} (${input.descriptor.provider})`.slice(0, 140),
        status: "pending", // CONSENT, owner-gated — parks in the decision queue (ADR-0258 Stage 2).
        expiresAt: null,
        events: [
          {
            type: "requested",
            detail: {
              source: "connect-once",
              connectionId: input.descriptor.id,
              provider: input.descriptor.provider,
            },
          },
        ],
      });
      return { id: req.id };
    },
  };
  return new ConnectOnceService(deps);
}
