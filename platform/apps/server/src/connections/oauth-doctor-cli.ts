#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import {
  googleConnectionOAuthConfigStatus,
  resolveGoogleConnectionRedirectUri,
} from "./google-oauth-config.js";
import {
  googleAdsConnectionOAuthConfigStatus,
  resolveGoogleAdsConnectionRedirectUri,
} from "./google-ads-oauth-config.js";
import { xConnectionOAuthConfigStatus } from "./x-oauth-config.js";
import { metaAdsConnectionOAuthConfigStatus } from "./meta-ads-oauth-config.js";
import { linkedInConnectionOAuthConfigStatus } from "./linkedin-oauth-config.js";
import { defaultConnectProvider } from "./default.js";

export type OAuthDoctorStatus = "pass" | "fail";

export interface OAuthDoctorCheck {
  name: string;
  status: OAuthDoctorStatus;
  message: string;
  callbackPath: string;
  redirectUri: string | null;
  missingEnv: string[];
}

interface ProviderSpec {
  id: string;
  label: string;
  status: (env: NodeJS.ProcessEnv) => {
    configured: boolean;
    missing: readonly string[];
    callbackPath: string;
  };
  redirectUri: (env: NodeJS.ProcessEnv) => string | null;
}

const PROVIDERS: readonly ProviderSpec[] = [
  {
    id: "google",
    label: "Google Search Console/Analytics",
    status: googleConnectionOAuthConfigStatus,
    redirectUri: resolveGoogleConnectionRedirectUri,
  },
  {
    id: "google_ads",
    label: "Google Ads",
    status: googleAdsConnectionOAuthConfigStatus,
    redirectUri: resolveGoogleAdsConnectionRedirectUri,
  },
  {
    id: "x",
    label: "X",
    status: xConnectionOAuthConfigStatus,
    redirectUri: (env) => env.X_CONNECTION_OAUTH_REDIRECT_URI?.trim() || null,
  },
  {
    id: "meta_ads",
    label: "Meta Ads",
    status: metaAdsConnectionOAuthConfigStatus,
    redirectUri: (env) => env.META_ADS_CONNECTION_OAUTH_REDIRECT_URI?.trim() || null,
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    status: linkedInConnectionOAuthConfigStatus,
    redirectUri: (env) => env.LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI?.trim() || null,
  },
];

export interface OAuthDoctorConfig {
  env: NodeJS.ProcessEnv;
}

export function parseOAuthDoctorConfig(env: NodeJS.ProcessEnv = process.env): OAuthDoctorConfig {
  return { env };
}

export function runOAuthDoctor(config: OAuthDoctorConfig): OAuthDoctorCheck[] {
  return PROVIDERS.map((provider): OAuthDoctorCheck => {
    const status = provider.status(config.env);
    const live = defaultConnectProvider(provider.id, config.env).live;
    const redirectUri = provider.redirectUri(config.env);
    const configured = status.configured && live;
    return {
      name: provider.id + "-connection-oauth",
      status: configured ? "pass" : "fail",
      message: configured
        ? provider.label + " OAuth config present and live provider selected"
        : provider.label + " OAuth config missing: " + status.missing.join(", "),
      callbackPath: status.callbackPath,
      redirectUri,
      missingEnv: [...status.missing],
    };
  });
}

async function main(): Promise<void> {
  const checks = runOAuthDoctor(parseOAuthDoctorConfig());
  for (const check of checks) {
    const redirect = check.redirectUri ? " redirect=" + check.redirectUri : "";
    console.log(
      check.status.toUpperCase() +
        " " +
        check.name +
        ": " +
        check.message +
        " callback=" +
        check.callbackPath +
        redirect,
    );
  }
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
