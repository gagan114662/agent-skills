/**
 * Google OAuth wiring for the #260 one-screen onboarding.
 *
 * The whole promise is ONE consent: identity (so we can create/attach the account), Search Console (so
 * Scout can verify the domain, submit the sitemap, request indexing) and Analytics (so the fleet can read
 * traffic) — no second prompt, no token paste, no DNS. This module is the pure half: the scope set, the
 * env-config loader, the authorize-URL builder, and the mapping from a Google token response to the
 * encrypted per-workspace connection (#192 vault) under service_key `google` — the SAME key the #258
 * connection model reads, so the live flow here and the connection abstraction reconcile.
 */

/** Identity (OpenID Connect) — lets us create/attach the user from their verified Google email. */
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"] as const;
/** Search Console — read+write so Scout can submit sitemaps & request indexing, not just read coverage. */
export const GOOGLE_SEARCH_CONSOLE_SCOPE = "https://www.googleapis.com/auth/webmasters";
/** Analytics — read-only traffic data for the SEO/analytics scorecard tiles. */
export const GOOGLE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/** The full scope set requested in the single consent. */
export const GOOGLE_OAUTH_SCOPES: readonly string[] = [
  ...GOOGLE_IDENTITY_SCOPES,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  GOOGLE_ANALYTICS_SCOPE,
];

/** Service key in the #192 vault / #258 connection model. Both the live flow and the connector key on this. */
export const GOOGLE_CONNECTION_SERVICE_KEY = "google";
/** Capabilities this one consent unlocks (recorded on the connection's `scopes`, matching #258 view shape). */
export const GOOGLE_CONNECTION_CAPABILITIES = ["identity", "search_console", "analytics"] as const;

export const GOOGLE_AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Load the deployment-wide Google OAuth app config from env, or null when not configured (so the feature
 * is off and the routes degrade honestly). Secrets stay in env at read-time, never in layered config —
 * mirroring how `BILLING_PROVIDER` / the GitHub token are read. Read live each call.
 */
export function loadGoogleOAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Google consent URL. `access_type=offline` + `prompt=consent` guarantee a refresh token so the
 * fleet keeps working after the access token expires; `include_granted_scopes` keeps any previously granted
 * scopes. `scopes` defaults to the full #260 set.
 */
export function buildGoogleAuthorizeUrl(input: {
  config: GoogleOAuthConfig;
  state: string;
  scopes?: readonly string[];
  loginHint?: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.config.clientId,
    redirect_uri: input.config.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? GOOGLE_OAUTH_SCOPES).join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state: input.state,
  });
  if (input.loginHint) params.set("login_hint", input.loginHint);
  return `${GOOGLE_AUTHORIZE_ENDPOINT}?${params.toString()}`;
}

/** A Google token response (the fields we keep). */
export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  scope?: string;
  tokenType?: string;
}

/** The verified Google identity we use to create/attach the account. */
export interface GoogleUserInfo {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/**
 * Map a Google token response (+ the verified identity) to the env-var → value map sealed into the #192
 * vault. The connector resolves these via `resolveServiceSecrets(workspaceId, 'google')`. The refresh
 * token is the load-bearing one (the fleet refreshes the access token); the access token + a computed
 * absolute expiry are stored so a connector can use it immediately without an extra round trip.
 */
export function googleConnectionSecrets(
  tokens: GoogleTokens,
  user: Pick<GoogleUserInfo, "sub" | "email">,
  now: number = Date.now(),
): Record<string, string> {
  const secrets: Record<string, string> = {
    GOOGLE_OAUTH_ACCESS_TOKEN: tokens.accessToken,
    GOOGLE_OAUTH_SCOPE: tokens.scope ?? GOOGLE_OAUTH_SCOPES.join(" "),
    GOOGLE_OAUTH_TOKEN_TYPE: tokens.tokenType ?? "Bearer",
    GOOGLE_ACCOUNT_SUB: user.sub,
    GOOGLE_ACCOUNT_EMAIL: user.email,
  };
  if (tokens.refreshToken) secrets.GOOGLE_OAUTH_REFRESH_TOKEN = tokens.refreshToken;
  if (typeof tokens.expiresInSec === "number") {
    secrets.GOOGLE_OAUTH_EXPIRES_AT = String(now + tokens.expiresInSec * 1000);
  }
  return secrets;
}
