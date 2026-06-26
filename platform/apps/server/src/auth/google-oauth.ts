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

export const GOOGLE_OAUTH_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_REDIRECT_URI",
] as const;

export type GoogleOAuthEnvKey = (typeof GOOGLE_OAUTH_ENV_KEYS)[number];

export interface GoogleOAuthConfigStatus {
  configured: boolean;
  missing: GoogleOAuthEnvKey[];
}

export function googleOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): GoogleOAuthConfigStatus {
  const missing = GOOGLE_OAUTH_ENV_KEYS.filter((key) => !env[key]?.trim());
  return { configured: missing.length === 0, missing };
}

/**
 * Load the deployment-wide Google OAuth app config from env, or null when not configured (so the feature
 * is off and the routes degrade honestly). Secrets stay in env at read-time, never in layered config —
 * mirroring how `BILLING_PROVIDER` / the GitHub token are read. Read live each call.
 */
export function loadGoogleOAuthConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig | null {
  if (!googleOAuthConfigStatus(env).configured) return null;
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  return { clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri! };
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

/**
 * Progressive consent (#300, ADR-0300). The point in the journey a Google consent is requested at:
 *  - `"signup"` — the front-door identity step (create/attach the account); identity-only when progressive
 *    scopes are on, so a prospect never grants Search Console / Analytics just to sign up.
 *  - `"seo"`    — the deferred grant requested when the user actually initiates SEO work; the full set.
 */
export type OnboardingIntent = "signup" | "seo";

/**
 * Decide which scopes a consent should request. Pure + total. With progressive scopes OFF (the #260
 * default) EVERY consent requests the full set — today's behavior, byte-for-byte. With progressive ON, the
 * signup step requests identity only and the SEO step requests the full set (GSC + Analytics), so the broad
 * data scopes are deferred to the moment SEO work is initiated (#300 AC).
 */
export function resolveOnboardingScopes(input: {
  progressive: boolean;
  intent: OnboardingIntent;
}): readonly string[] {
  if (!input.progressive) return GOOGLE_OAUTH_SCOPES;
  return input.intent === "seo" ? GOOGLE_OAUTH_SCOPES : [...GOOGLE_IDENTITY_SCOPES];
}

/**
 * Derive the connection capability list (the #258 view shape) from a requested scope set. Pure + total:
 * the full scope set maps back to {@link GOOGLE_CONNECTION_CAPABILITIES} exactly, while an identity-only
 * signup consent records only `["identity"]` — so a deferred-SEO workspace honestly shows it has not yet
 * granted Search Console / Analytics until the user asks Scout to do SEO work.
 */
export function capabilitiesForScopes(scopes: readonly string[]): string[] {
  const caps: string[] = [];
  if (GOOGLE_IDENTITY_SCOPES.some((s) => scopes.includes(s))) caps.push("identity");
  if (scopes.includes(GOOGLE_SEARCH_CONSOLE_SCOPE)) caps.push("search_console");
  if (scopes.includes(GOOGLE_ANALYTICS_SCOPE)) caps.push("analytics");
  return caps;
}

/**
 * Union an existing connection's recorded capabilities with the freshly-requested ones, existing-first and
 * de-duplicated. Pure + total. This is the anti-downgrade rule (#300): a returning user whose workspace
 * already granted Search Console / Analytics must keep them even when this login only requested identity —
 * progressive consent can only ever ADD capabilities, never silently remove one.
 */
export function mergeGrantedCapabilities(
  existing: readonly string[],
  requested: readonly string[],
): string[] {
  return Array.from(new Set([...existing, ...requested]));
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
