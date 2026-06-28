import type { ConnectionDescriptor } from "./registry.js";

const POSTMARK_TOKEN_KEY = "POSTMARK_SERVER_TOKEN";
const POSTMARK_FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const REACH_SEND_PROVIDER_KEY = "RELOAD_REACH_SEND_PROVIDER";
const REACH_LIVE_SEND_ENABLED_KEY = "RELOAD_REACH_LIVE_SEND_ENABLED";
const ACQUISITION_ENABLED_KEY = "RELOAD_ACQUISITION_ENABLED";
const ACQUISITION_EMAIL_KEY = "RELOAD_ACQUISITION_EMAIL";
const ACQUISITION_ESP_PROVIDER_KEY = "RELOAD_ACQUISITION_ESP_PROVIDER";
const ACQUISITION_BRAND_NAME_KEY = "RELOAD_ACQUISITION_BRAND_NAME";
const ACQUISITION_POSTAL_ADDRESS_KEY = "RELOAD_ACQUISITION_POSTAL_ADDRESS";
const ACQUISITION_UNSUBSCRIBE_URL_KEY = "RELOAD_ACQUISITION_UNSUBSCRIBE_URL";

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

export function emailOutboundConfigIssue(input: {
  reach: EmailReadinessReach | undefined;
  env?: NodeJS.ProcessEnv;
}): ConnectionDescriptor["configIssue"] | undefined {
  const env = input.env ?? process.env;
  const missing: string[] = [];
  if (input.reach?.sendProvider !== "postmark") missing.push(REACH_SEND_PROVIDER_KEY + "=postmark");
  if (input.reach?.liveSendEnabled !== true) missing.push(REACH_LIVE_SEND_ENABLED_KEY + "=1");
  if (!env[POSTMARK_TOKEN_KEY]?.trim()) missing.push(POSTMARK_TOKEN_KEY);
  if (!firstEnv(env, POSTMARK_FROM_KEYS)) {
    missing.push("POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER");
  }
  if (!flagEnabled(env[ACQUISITION_ENABLED_KEY])) missing.push(ACQUISITION_ENABLED_KEY + "=true");
  if (!flagEnabled(env[ACQUISITION_EMAIL_KEY])) missing.push(ACQUISITION_EMAIL_KEY + "=true");
  if (env[ACQUISITION_ESP_PROVIDER_KEY]?.trim() !== "postmark") {
    missing.push(ACQUISITION_ESP_PROVIDER_KEY + "=postmark");
  }
  if (!env[ACQUISITION_BRAND_NAME_KEY]?.trim()) missing.push(ACQUISITION_BRAND_NAME_KEY);
  if (!env[ACQUISITION_POSTAL_ADDRESS_KEY]?.trim()) missing.push(ACQUISITION_POSTAL_ADDRESS_KEY);
  if (!env[ACQUISITION_UNSUBSCRIBE_URL_KEY]?.trim()) missing.push(ACQUISITION_UNSUBSCRIBE_URL_KEY);
  if (missing.length === 0) return undefined;
  return {
    code: "email_outbound_live_send_missing_config",
    missingEnv: missing,
    remedy:
      "Set Postmark token/sender env, enable reach live-send and acquisition email with Postmark, add brand/postal/unsubscribe compliance env, then enable Connect email again so ipop can seal provider proof.",
  };
}
