export const LINKEDIN_CONNECTION_CALLBACK_PATH = "/me/connections/linkedin/oauth/callback";

export const LINKEDIN_CONNECTION_OAUTH_ENV_KEYS = [
  "LINKEDIN_OAUTH_CLIENT_ID",
  "LINKEDIN_OAUTH_CLIENT_SECRET",
  "LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI",
] as const;

export type LinkedInConnectionOAuthEnvKey = (typeof LINKEDIN_CONNECTION_OAUTH_ENV_KEYS)[number];

export interface LinkedInConnectionOAuthConfigStatus {
  configured: boolean;
  missing: LinkedInConnectionOAuthEnvKey[];
  callbackPath: typeof LINKEDIN_CONNECTION_CALLBACK_PATH;
}

export function linkedInConnectionOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): LinkedInConnectionOAuthConfigStatus {
  const missing = LINKEDIN_CONNECTION_OAUTH_ENV_KEYS.filter((key) => !env[key]?.trim());
  return {
    configured: missing.length === 0,
    missing,
    callbackPath: LINKEDIN_CONNECTION_CALLBACK_PATH,
  };
}
