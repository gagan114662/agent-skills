export const X_CONNECTION_CALLBACK_PATH = "/me/connections/x/oauth/callback";

export const X_CONNECTION_OAUTH_ENV_KEYS = [
  "X_OAUTH_CLIENT_ID",
  "X_OAUTH_CLIENT_SECRET",
  "X_CONNECTION_OAUTH_REDIRECT_URI",
] as const;

export type XConnectionOAuthEnvKey = (typeof X_CONNECTION_OAUTH_ENV_KEYS)[number];

export interface XConnectionOAuthConfigStatus {
  configured: boolean;
  missing: XConnectionOAuthEnvKey[];
  callbackPath: typeof X_CONNECTION_CALLBACK_PATH;
}

export function xConnectionOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): XConnectionOAuthConfigStatus {
  const missing = X_CONNECTION_OAUTH_ENV_KEYS.filter((key) => !env[key]?.trim());
  return {
    configured: missing.length === 0,
    missing,
    callbackPath: X_CONNECTION_CALLBACK_PATH,
  };
}
