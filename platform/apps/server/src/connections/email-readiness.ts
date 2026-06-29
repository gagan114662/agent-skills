import type { ConnectionDescriptor } from "./registry.js";

const POSTMARK_TOKEN_KEY = "POSTMARK_SERVER_TOKEN";
const POSTMARK_FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const RESEND_TOKEN_KEY = "RESEND_API_KEY";
const RESEND_FROM_KEYS = ["RESEND_FROM", "RESEND_FROM_ADDRESS", "RELOAD_FLEET_FROM_EMAIL"] as const;
const REACH_SEND_PROVIDER_KEY = "RELOAD_REACH_SEND_PROVIDER";
const REACH_LIVE_SEND_ENABLED_KEY = "RELOAD_REACH_LIVE_SEND_ENABLED";
const ACQUISITION_ENABLED_KEY = "RELOAD_ACQUISITION_ENABLED";
const ACQUISITION_EMAIL_KEY = "RELOAD_ACQUISITION_EMAIL";
const ACQUISITION_ESP_PROVIDER_KEY = "RELOAD_ACQUISITION_ESP_PROVIDER";
const ACQUISITION_BRAND_NAME_KEY = "RELOAD_ACQUISITION_BRAND_NAME";
const ACQUISITION_POSTAL_ADDRESS_KEY = "RELOAD_ACQUISITION_POSTAL_ADDRESS";
const ACQUISITION_UNSUBSCRIBE_URL_KEY = "RELOAD_ACQUISITION_UNSUBSCRIBE_URL";
const EMAIL_PROVIDERS = ["postmark", "resend"] as const;

type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

interface EmailReadinessReach {
  sendProvider?: string;
  liveSendEnabled?: boolean;
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function flagEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function emailProvider(value: string | undefined): EmailProvider | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return (EMAIL_PROVIDERS as readonly string[]).includes(normalized) ? (normalized as EmailProvider) : null;
}

function missingProviderCredential(provider: EmailProvider, env: NodeJS.ProcessEnv): string[] {
  if (provider === "postmark") {
    return [
      ...(env[POSTMARK_TOKEN_KEY]?.trim() ? [] : [POSTMARK_TOKEN_KEY]),
      ...(firstEnv(env, POSTMARK_FROM_KEYS) ? [] : ["POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER"]),
    ];
  }
  return [
    ...(env[RESEND_TOKEN_KEY]?.trim() ? [] : [RESEND_TOKEN_KEY]),
    ...(firstEnv(env, RESEND_FROM_KEYS) ? [] : ["RESEND_FROM or RESEND_FROM_ADDRESS or RELOAD_FLEET_FROM_EMAIL"]),
  ];
}

export function emailOutboundConfigIssue(input: {
  reach: EmailReadinessReach | undefined;
  env?: NodeJS.ProcessEnv;
}): ConnectionDescriptor["configIssue"] | undefined {
  const env = input.env ?? process.env;
  const missing: string[] = [];
  const reachProvider = emailProvider(input.reach?.sendProvider);
  const acquisitionProvider = emailProvider(env[ACQUISITION_ESP_PROVIDER_KEY]);
  const provider = reachProvider ?? acquisitionProvider;
  if (!reachProvider) missing.push(REACH_SEND_PROVIDER_KEY + "=postmark or resend");
  if (input.reach?.liveSendEnabled !== true) missing.push(REACH_LIVE_SEND_ENABLED_KEY + "=1");
  if (provider) missing.push(...missingProviderCredential(provider, env));
  else missing.push("POSTMARK_SERVER_TOKEN + sender or RESEND_API_KEY + sender");
  if (!flagEnabled(env[ACQUISITION_ENABLED_KEY])) missing.push(ACQUISITION_ENABLED_KEY + "=true");
  if (!flagEnabled(env[ACQUISITION_EMAIL_KEY])) missing.push(ACQUISITION_EMAIL_KEY + "=true");
  if (!acquisitionProvider) {
    missing.push(ACQUISITION_ESP_PROVIDER_KEY + (reachProvider ? "=" + reachProvider : "=postmark or resend"));
  } else if (reachProvider && acquisitionProvider !== reachProvider) {
    missing.push(ACQUISITION_ESP_PROVIDER_KEY + "=" + reachProvider);
  }
  if (!env[ACQUISITION_BRAND_NAME_KEY]?.trim()) missing.push(ACQUISITION_BRAND_NAME_KEY);
  if (!env[ACQUISITION_POSTAL_ADDRESS_KEY]?.trim()) missing.push(ACQUISITION_POSTAL_ADDRESS_KEY);
  if (!env[ACQUISITION_UNSUBSCRIBE_URL_KEY]?.trim()) missing.push(ACQUISITION_UNSUBSCRIBE_URL_KEY);
  if (missing.length === 0) return undefined;
  return {
    code: "email_outbound_live_send_missing_config",
    missingEnv: missing,
    remedy:
      "Set a supported ESP token/sender env, enable reach live-send and acquisition email with the same provider, add brand/postal/unsubscribe compliance env, then enable Connect email again so ipop can seal provider proof.",
  };
}
