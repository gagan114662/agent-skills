export const GOOGLE_ADS_CONNECTION_CALLBACK_PATH = "/me/connections/google_ads/oauth/callback";

export const GOOGLE_ADS_CONNECTION_OAUTH_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI",
] as const;

export type GoogleAdsConnectionOAuthEnvKey = (typeof GOOGLE_ADS_CONNECTION_OAUTH_ENV_KEYS)[number];

export interface GoogleAdsConnectionOAuthConfigStatus {
  configured: boolean;
  missing: GoogleAdsConnectionOAuthEnvKey[];
  callbackPath: typeof GOOGLE_ADS_CONNECTION_CALLBACK_PATH;
}

export function resolveGoogleAdsConnectionRedirectUri(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;

  const signInRedirect = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!signInRedirect) return null;
  try {
    const url = new URL(signInRedirect);
    url.pathname = GOOGLE_ADS_CONNECTION_CALLBACK_PATH;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function googleAdsConnectionOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): GoogleAdsConnectionOAuthConfigStatus {
  const missing = GOOGLE_ADS_CONNECTION_OAUTH_ENV_KEYS.filter((key) => {
    if (key === "GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI") {
      return !resolveGoogleAdsConnectionRedirectUri(env);
    }
    return !env[key]?.trim();
  });
  return {
    configured: missing.length === 0,
    missing,
    callbackPath: GOOGLE_ADS_CONNECTION_CALLBACK_PATH,
  };
}
