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
import type { ServiceCredentialRow } from "../db/repositories/external-credentials.js";

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
  workspaceId: string | null;
}

export interface OAuthVaultReadbackCheck {
  name: string;
  status: OAuthDoctorStatus;
  message: string;
  envKeys: string[];
  fingerprint: string | null;
  connectedAtMs: number | null;
}

export function parseOAuthDoctorConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
): OAuthDoctorConfig {
  return { env, workspaceId: parseWorkspaceId(env, argv) };
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

export function runOAuthVaultReadback(statuses: readonly ServiceCredentialRow[]): OAuthVaultReadbackCheck[] {
  const byKey = new Map(statuses.map((row) => [row.serviceKey, row]));
  return PROVIDERS.map((provider): OAuthVaultReadbackCheck => {
    const row = byKey.get(provider.id);
    const connected = Boolean(row?.connected && row.status === "connected" && row.envKeys.length > 0);
    return {
      name: provider.id + "-vault-readback",
      status: connected ? "pass" : "fail",
      message: connected
        ? provider.label + " sealed credential proof is present"
        : provider.label + " has no sealed credential proof for this workspace",
      envKeys: row?.envKeys ?? [],
      fingerprint: connected ? row!.fingerprint : null,
      connectedAtMs: connected ? row!.connectedAtMs : null,
    };
  });
}

function parseWorkspaceId(env: NodeJS.ProcessEnv, argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--workspace-id") return argv[i + 1]?.trim() || null;
    if (arg.startsWith("--workspace-id=")) return arg.slice("--workspace-id=".length).trim() || null;
  }
  return env.OAUTH_DOCTOR_WORKSPACE_ID?.trim() || env.RELOAD_OWNER_WORKSPACE_ID?.trim() || null;
}

async function main(): Promise<void> {
  const config = parseOAuthDoctorConfig();
  const checks = runOAuthDoctor(config);
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
  let readback: OAuthVaultReadbackCheck[] = [];
  if (config.workspaceId) {
    const { listServiceStatuses } = await import("../db/repositories/external-credentials.js");
    readback = runOAuthVaultReadback(await listServiceStatuses(config.workspaceId));
    for (const check of readback) {
      const fingerprint = check.fingerprint ? " fingerprint=vault:" + check.fingerprint.slice(0, 12) : "";
      const envKeys = check.envKeys.length > 0 ? " envKeys=" + check.envKeys.join(",") : "";
      console.log(
        check.status.toUpperCase() +
          " " +
          check.name +
          ": " +
          check.message +
          envKeys +
          fingerprint,
      );
    }
  }
  if ([...checks, ...readback].some((check) => check.status === "fail")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
