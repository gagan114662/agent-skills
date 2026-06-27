export const META_ADS_CONNECTION_CALLBACK_PATH = "/me/connections/meta_ads/oauth/callback";

export const META_ADS_CONNECTION_OAUTH_ENV_KEYS = [
  "META_OAUTH_CLIENT_ID",
  "META_OAUTH_CLIENT_SECRET",
  "META_ADS_CONNECTION_OAUTH_REDIRECT_URI",
] as const;

export type MetaAdsConnectionOAuthEnvKey = (typeof META_ADS_CONNECTION_OAUTH_ENV_KEYS)[number];

export interface MetaAdsConnectionOAuthConfigStatus {
  configured: boolean;
  missing: MetaAdsConnectionOAuthEnvKey[];
  callbackPath: typeof META_ADS_CONNECTION_CALLBACK_PATH;
}

export function metaAdsConnectionOAuthConfigStatus(
  env: NodeJS.ProcessEnv = process.env,
): MetaAdsConnectionOAuthConfigStatus {
  const missing = META_ADS_CONNECTION_OAUTH_ENV_KEYS.filter((key) => !env[key]?.trim());
  return {
    configured: missing.length === 0,
    missing,
    callbackPath: META_ADS_CONNECTION_CALLBACK_PATH,
  };
}
