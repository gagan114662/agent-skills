#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import { PostmarkEspProvider } from "../email/postmark-provider.js";

export type OutboundDoctorStatus = "pass" | "fail" | "warn";

export interface OutboundDoctorCheck {
  name: string;
  status: OutboundDoctorStatus;
  message: string;
}

export interface OutboundDoctorConfig {
  serverToken: string;
  from: string;
  acquisitionEnabled: boolean;
  acquisitionEmailEnabled: boolean;
  acquisitionEspProvider: string;
  brandName: string;
  postalAddress: string;
  unsubscribeUrl: string;
  sendSmoke: boolean;
  smokeTo: string;
  smokeSubject: string;
  smokeText: string;
  apiBaseUrl: string;
}

export interface OutboundDoctorDeps {
  fetchImpl?: typeof fetch;
}

const FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;

function hasArg(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const prefix = name + "=";
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function flag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function parseOutboundDoctorConfig(
  input: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
  } = {},
): OutboundDoctorConfig {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  return {
    serverToken: env.POSTMARK_SERVER_TOKEN?.trim() ?? "",
    from: firstEnv(env, FROM_KEYS),
    acquisitionEnabled: flag(env.RELOAD_ACQUISITION_ENABLED),
    acquisitionEmailEnabled: flag(env.RELOAD_ACQUISITION_EMAIL),
    acquisitionEspProvider: env.RELOAD_ACQUISITION_ESP_PROVIDER?.trim() ?? "",
    brandName: env.RELOAD_ACQUISITION_BRAND_NAME?.trim() ?? "",
    postalAddress: env.RELOAD_ACQUISITION_POSTAL_ADDRESS?.trim() ?? "",
    unsubscribeUrl: env.RELOAD_ACQUISITION_UNSUBSCRIBE_URL?.trim() ?? "",
    sendSmoke: hasArg(argv, "--send-smoke"),
    smokeTo: argValue(argv, "--to")?.trim() ?? "",
    smokeSubject: argValue(argv, "--subject") ?? "ipop outbound doctor smoke",
    smokeText:
      argValue(argv, "--text") ??
      "ipop outbound doctor smoke: Postmark live-send setup is reachable; reply to complete first-customer proof.",
    apiBaseUrl: env.POSTMARK_API_BASE_URL?.trim() || "https://api.postmarkapp.com",
  };
}

function configCheck(config: OutboundDoctorConfig): OutboundDoctorCheck {
  const missing: string[] = [];
  if (!config.serverToken) missing.push("POSTMARK_SERVER_TOKEN");
  if (!config.from) missing.push("POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER");
  return {
    name: "postmark-config",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? "Postmark token and sender env present"
        : "missing: " + missing.join(", "),
  };
}

function acquisitionCheck(config: OutboundDoctorConfig): OutboundDoctorCheck {
  const missing: string[] = [];
  if (!config.acquisitionEnabled) missing.push("RELOAD_ACQUISITION_ENABLED=true");
  if (!config.acquisitionEmailEnabled) missing.push("RELOAD_ACQUISITION_EMAIL=true");
  if (config.acquisitionEspProvider !== "postmark")
    missing.push("RELOAD_ACQUISITION_ESP_PROVIDER=postmark");
  return {
    name: "acquisition-email-live",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? "acquisition email is configured to use Postmark"
        : "not live-send ready: " + missing.join(", "),
  };
}

function complianceCheck(config: OutboundDoctorConfig): OutboundDoctorCheck {
  const missing: string[] = [];
  if (!config.brandName) missing.push("RELOAD_ACQUISITION_BRAND_NAME");
  if (!config.postalAddress) missing.push("RELOAD_ACQUISITION_POSTAL_ADDRESS");
  if (!config.unsubscribeUrl) missing.push("RELOAD_ACQUISITION_UNSUBSCRIBE_URL");
  return {
    name: "acquisition-compliance",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? "CAN-SPAM footer config present"
        : "missing compliance env: " + missing.join(", "),
  };
}

async function jsonFetch(input: {
  url: string;
  init?: RequestInit;
  fetchImpl: typeof fetch;
}): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const response = await input.fetchImpl(input.url, input.init);
  const payload = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, payload };
}

async function checkPostmarkServer(
  config: OutboundDoctorConfig,
  fetchImpl: typeof fetch,
): Promise<OutboundDoctorCheck> {
  if (!config.serverToken) {
    return { name: "postmark-server", status: "fail", message: "POSTMARK_SERVER_TOKEN is missing" };
  }
  try {
    const result = await jsonFetch({
      url: config.apiBaseUrl.replace(/\/+$/, "") + "/server",
      fetchImpl,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Postmark-Server-Token": config.serverToken,
        },
      },
    });
    const payload = result.payload as { ID?: number; Name?: string; Message?: string } | null;
    if (!result.ok || typeof payload?.ID !== "number") {
      return {
        name: "postmark-server",
        status: "fail",
        message: payload?.Message ?? "Postmark /server lookup failed with HTTP " + result.status,
      };
    }
    return {
      name: "postmark-server",
      status: "pass",
      message: "Postmark server reachable" + (payload.Name ? " (" + payload.Name + ")" : ""),
    };
  } catch (error) {
    return {
      name: "postmark-server",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function maybeSendSmoke(
  config: OutboundDoctorConfig,
  fetchImpl: typeof fetch,
): Promise<OutboundDoctorCheck> {
  if (!config.sendSmoke) {
    return {
      name: "postmark-send-smoke",
      status: "warn",
      message: "skipped; pass --send-smoke --to <recipient> to send a tagged Postmark message",
    };
  }
  if (!config.smokeTo) {
    return {
      name: "postmark-send-smoke",
      status: "fail",
      message: "--to is required when --send-smoke is set",
    };
  }
  if (!config.serverToken || !config.from) {
    return {
      name: "postmark-send-smoke",
      status: "fail",
      message: "POSTMARK_SERVER_TOKEN and sender env are required before sending smoke",
    };
  }
  try {
    const provider = new PostmarkEspProvider({
      serverToken: config.serverToken,
      from: config.from,
      fetchImpl,
      html: false,
    });
    const result = await provider.send({
      to: config.smokeTo,
      subject: config.smokeSubject,
      body: config.smokeText,
      headers: {
        "X-ipop-Proof": "outbound-doctor-smoke",
      },
    });
    return {
      name: "postmark-send-smoke",
      status: "pass",
      message: "sent Postmark smoke message id " + result.externalId,
    };
  } catch (error) {
    return {
      name: "postmark-send-smoke",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runOutboundDoctor(
  config: OutboundDoctorConfig,
  deps: OutboundDoctorDeps = {},
): Promise<OutboundDoctorCheck[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return [
    configCheck(config),
    acquisitionCheck(config),
    complianceCheck(config),
    await checkPostmarkServer(config, fetchImpl),
    await maybeSendSmoke(config, fetchImpl),
  ];
}

async function main(): Promise<void> {
  const checks = await runOutboundDoctor(parseOutboundDoctorConfig());
  for (const check of checks) {
    console.log(check.status.toUpperCase() + " " + check.name + ": " + check.message);
  }
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
