export const GOOGLE_CONNECTION_CALLBACK_PATH = "/me/connections/google/oauth/callback";

export const GOOGLE_CONNECTION_OAUTH_ENV_KEYS = [
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_CONNECTION_OAUTH_REDIRECT_URI",
] as const;

export type GoogleConnectionOAuthEnvKey = (typeof GOOGLE_CONNECTION_OAUTH_ENV_KEYS)[number];

export interface GoogleConnectionOAuthConfigStatus {
  configured: boolean;
  missing: GoogleConnectionOAuthEnvKey[];
  callbackPath: typeof GOOGLE_CONNECTION_CALLBACK_PATH;
}

export function resolveGoogleConnectionRedirectUri(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.GOOGLE_CONNECTION_OAUTH_REDIRECT_URI?.trim();
  if (explicit) return explicit;

  const signInRedirect = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!signInRedirect) return null;
  try {
    const url = new URL(signInRedirect);
    url.pathname = GOOGLE_CONNECTION_CALLBACK_PATH;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function googleConnectionOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): GoogleConnectionOAuthConfigStatus {
  const missing = GOOGLE_CONNECTION_OAUTH_ENV_KEYS.filter((key) => {
    if (key === "GOOGLE_CONNECTION_OAUTH_REDIRECT_URI") {
      return !resolveGoogleConnectionRedirectUri(env);
    }
    return !env[key]?.trim();
  });
  return {
    configured: missing.length === 0,
    missing,
    callbackPath: GOOGLE_CONNECTION_CALLBACK_PATH,
  };
}
