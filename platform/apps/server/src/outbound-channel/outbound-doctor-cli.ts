#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import { PostmarkEspProvider } from "../email/postmark-provider.js";
import { ResendEspProvider } from "../email/resend-provider.js";
import type { OutboundDeliveryProof } from "../first-customer/proof.js";
import { channelForEspProvider } from "./channel.js";
import { buildEspReadbackReceipt } from "./receipt.js";

type VerifyAndRecordSend = typeof import("./service.js").verifyAndRecordSend;

export type OutboundDoctorStatus = "pass" | "fail" | "warn";

export interface OutboundDoctorCheck {
  name: string;
  status: OutboundDoctorStatus;
  message: string;
  outboundDeliveryProof?: OutboundDeliveryProof;
}

export interface OutboundDoctorConfig {
  provider: string;
  serverToken: string;
  resendApiKey: string;
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
  workspaceId: string;
  approvalRequestId: string;
  trackingRef: string;
  proofJson: boolean;
  apiBaseUrl: string;
}

export interface OutboundDoctorDeps {
  fetchImpl?: typeof fetch;
  verifyAndRecordSend?: VerifyAndRecordSend;
}

const FROM_KEYS = ["POSTMARK_FROM", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER"] as const;
const RESEND_FROM_KEYS = ["RESEND_FROM", "RESEND_FROM_ADDRESS", "RELOAD_FLEET_FROM_EMAIL"] as const;

function normalizeProvider(value: string | undefined): string {
  const provider = value?.trim().toLowerCase() ?? "";
  return provider || "postmark";
}

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
  const provider = normalizeProvider(
    argValue(argv, "--provider") ?? env.RELOAD_ACQUISITION_ESP_PROVIDER ?? env.RELOAD_REACH_SEND_PROVIDER,
  );
  return {
    provider,
    serverToken: env.POSTMARK_SERVER_TOKEN?.trim() ?? "",
    resendApiKey: env.RESEND_API_KEY?.trim() ?? "",
    from: provider === "resend" ? firstEnv(env, RESEND_FROM_KEYS) : firstEnv(env, FROM_KEYS),
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
      "ipop outbound doctor smoke: " + provider + " live-send setup is reachable; reply to complete first-customer proof.",
    workspaceId:
      argValue(argv, "--workspace-id")?.trim() ??
      env.RELOAD_OWNER_WORKSPACE_ID?.trim() ??
      env.RELOAD_MARKETING_OWNER_WORKSPACE_ID?.trim() ??
      "",
    approvalRequestId:
      argValue(argv, "--approval-request-id")?.trim() ??
      env.RELOAD_OUTBOUND_DOCTOR_APPROVAL_REQUEST_ID?.trim() ??
      "",
    trackingRef:
      argValue(argv, "--tracking-ref")?.trim() ??
      env.RELOAD_OUTBOUND_DOCTOR_TRACKING_REF?.trim() ??
      "",
    proofJson: hasArg(argv, "--proof-json"),
    apiBaseUrl:
      provider === "resend"
        ? env.RESEND_API_BASE_URL?.trim() || "https://api.resend.com"
        : env.POSTMARK_API_BASE_URL?.trim() || "https://api.postmarkapp.com",
  };
}

function configCheck(config: OutboundDoctorConfig): OutboundDoctorCheck {
  const missing: string[] = [];
  if (config.provider === "resend") {
    if (!config.resendApiKey) missing.push("RESEND_API_KEY");
    if (!config.from) missing.push("RESEND_FROM or RESEND_FROM_ADDRESS or RELOAD_FLEET_FROM_EMAIL");
  } else {
    if (!config.serverToken) missing.push("POSTMARK_SERVER_TOKEN");
    if (!config.from) missing.push("POSTMARK_FROM or POSTMARK_FROM_ADDRESS or POSTMARK_SENDER");
  }
  return {
    name: config.provider + "-config",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? config.provider + " token and sender env present"
        : "missing: " + missing.join(", "),
  };
}

function acquisitionCheck(config: OutboundDoctorConfig): OutboundDoctorCheck {
  const missing: string[] = [];
  if (!config.acquisitionEnabled) missing.push("RELOAD_ACQUISITION_ENABLED=true");
  if (!config.acquisitionEmailEnabled) missing.push("RELOAD_ACQUISITION_EMAIL=true");
  if (config.acquisitionEspProvider !== config.provider)
    missing.push("RELOAD_ACQUISITION_ESP_PROVIDER=" + config.provider);
  return {
    name: "acquisition-email-live",
    status: missing.length === 0 ? "pass" : "fail",
    message:
      missing.length === 0
        ? "acquisition email is configured to use " + config.provider
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

async function checkResendDomains(
  config: OutboundDoctorConfig,
  fetchImpl: typeof fetch,
): Promise<OutboundDoctorCheck> {
  if (!config.resendApiKey) {
    return { name: "resend-domains", status: "fail", message: "RESEND_API_KEY is missing" };
  }
  try {
    const result = await jsonFetch({
      url: config.apiBaseUrl.replace(/\/+$/, "") + "/domains",
      fetchImpl,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer " + config.resendApiKey,
          "User-Agent": "ipop-server/1.0",
        },
      },
    });
    const payload = result.payload as { object?: string; data?: unknown[]; message?: string } | null;
    if (!result.ok || payload?.object !== "list" || !Array.isArray(payload.data)) {
      return {
        name: "resend-domains",
        status: "fail",
        message: payload?.message ?? "Resend /domains lookup failed with HTTP " + result.status,
      };
    }
    return {
      name: "resend-domains",
      status: "pass",
      message: "Resend API key reachable; domains returned " + payload.data.length,
    };
  } catch (error) {
    return {
      name: "resend-domains",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function providerIdentityCheck(
  config: OutboundDoctorConfig,
  fetchImpl: typeof fetch,
): Promise<OutboundDoctorCheck> {
  if (config.provider === "resend") return checkResendDomains(config, fetchImpl);
  return checkPostmarkServer(config, fetchImpl);
}

async function maybeSendSmoke(
  config: OutboundDoctorConfig,
  fetchImpl: typeof fetch,
  verifyAndRecordSend: VerifyAndRecordSend,
): Promise<OutboundDoctorCheck[]> {
  const smokeCheckName = config.provider + "-send-smoke";
  if (!config.sendSmoke) {
    return [
      {
        name: smokeCheckName,
        status: "warn",
        message: "skipped; pass --send-smoke --to <recipient> to send a tagged " + config.provider + " message",
      },
    ];
  }
  if (!config.smokeTo) {
    return [
      {
        name: smokeCheckName,
        status: "fail",
        message: "--to is required when --send-smoke is set",
      },
    ];
  }
  const credentialMissing =
    config.provider === "resend"
      ? !config.resendApiKey || !config.from
      : !config.serverToken || !config.from;
  if (credentialMissing) {
    return [
      {
        name: smokeCheckName,
        status: "fail",
        message:
          config.provider === "resend"
            ? "RESEND_API_KEY and sender env are required before sending smoke"
            : "POSTMARK_SERVER_TOKEN and sender env are required before sending smoke",
      },
    ];
  }
  if (config.proofJson && (!config.workspaceId || !config.approvalRequestId || !config.trackingRef)) {
    return [
      {
        name: "outbound-proof-json",
        status: "fail",
        message:
          "--proof-json requires --workspace-id, --approval-request-id, and --tracking-ref before sending a proof smoke",
      },
    ];
  }
  try {
    const channel = channelForEspProvider(config.provider);
    if (!channel) {
      return [{ name: smokeCheckName, status: "fail", message: "unsupported ESP provider " + config.provider }];
    }
    const provider =
      config.provider === "resend"
        ? new ResendEspProvider({
            apiKey: config.resendApiKey,
            from: config.from,
            fetchImpl,
            html: false,
          })
        : new PostmarkEspProvider({
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
    const observedAt = new Date().toISOString();
    const receipt = buildEspReadbackReceipt({
      messageId: result.externalId,
      observedAt,
      detail: { provider: config.provider, source: "outbound-doctor-smoke" },
    });
    const outboundDeliveryProof = receipt
      ? {
          channel,
          provider: config.provider,
          receipt,
          recipient: config.smokeTo,
          approvalRequestId: config.approvalRequestId,
          trackingRef: config.trackingRef,
        }
      : undefined;
    const checks: OutboundDoctorCheck[] = [
      {
        name: smokeCheckName,
        status: "pass",
        message: "sent " + config.provider + " smoke message id " + result.externalId,
        outboundDeliveryProof,
      },
    ];
    if (!config.workspaceId || !config.approvalRequestId) {
      checks.push({
        name: "outbound-proof-ledger",
        status: "warn",
        message:
          "not recorded; pass --workspace-id and --approval-request-id to append a verified #13 send receipt",
      });
      return checks;
    }
    const recorded = await verifyAndRecordSend({
      workspaceId: config.workspaceId,
      channel,
      recipient: config.smokeTo,
      approvalRequestId: config.approvalRequestId,
      probe: async () => ({
        messageId: result.externalId,
        observedAt,
        detail: { provider: config.provider, source: "outbound-doctor-smoke" },
      }),
    });
    checks.push({
      name: "outbound-proof-ledger",
      status: recorded.verified ? "pass" : "fail",
      message: recorded.verified
        ? "recorded verified send receipt " + (recorded.row?.id ?? "(no row id)")
        : config.provider + " returned a message id but the receipt did not verify",
      outboundDeliveryProof,
    });
    return checks;
  } catch (error) {
    return [
      {
        name: smokeCheckName,
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

export async function runOutboundDoctor(
  config: OutboundDoctorConfig,
  deps: OutboundDoctorDeps = {},
): Promise<OutboundDoctorCheck[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const verifyAndRecordSend: VerifyAndRecordSend =
    deps.verifyAndRecordSend ??
    (async (...args) => {
      const mod = await import("./service.js");
      return mod.verifyAndRecordSend(...args);
    });
  return [
    configCheck(config),
    acquisitionCheck(config),
    complianceCheck(config),
    await providerIdentityCheck(config, fetchImpl),
    ...(await maybeSendSmoke(config, fetchImpl, verifyAndRecordSend)),
  ];
}

async function main(): Promise<void> {
  const config = parseOutboundDoctorConfig();
  const checks = await runOutboundDoctor(config);
  for (const check of checks) {
    console.log(check.status.toUpperCase() + " " + check.name + ": " + check.message);
  }
  const proof = checks.find((check) => check.outboundDeliveryProof)?.outboundDeliveryProof;
  if (proof && config.proofJson) {
    console.log(JSON.stringify({ outboundDelivery: proof }, null, 2));
  }
  if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
