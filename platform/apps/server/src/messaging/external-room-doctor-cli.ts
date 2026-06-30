#!/usr/bin/env tsx
import { pathToFileURL } from "node:url";
import { TELEGRAM_ROOM_CONNECTION_ID, WHATSAPP_ROOM_CONNECTION_ID } from "../connections/registry.js";
import { resolveServiceSecrets } from "../db/repositories/external-credentials.js";
import { loadEnv, type TelegramEnv, type WhatsAppEnv } from "../env.js";
import { TelegramRoomService } from "../telegram/service.js";
import { WhatsAppRoomService } from "../whatsapp/service.js";

export type DoctorStatus = "pass" | "fail" | "warn";
type ExternalRoomMessageProvider = "telegram" | "whatsapp";
type RecordExternalRoomMessageReceipt =
  typeof import("../db/repositories/external-room-message-receipts.js").recordExternalRoomMessageReceipt;
type ResolveServiceSecrets = typeof resolveServiceSecrets;

const TELEGRAM_WORKSPACE_CHAT_ID_KEY = "TELEGRAM_CHAT_ID";
const WHATSAPP_WORKSPACE_RECIPIENT_KEY = "WHATSAPP_RECIPIENT";
const PRODUCTION_API_BASE_URL = "https://api.ipop.ai";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export interface ExternalRoomDoctorConfig {
  telegram: TelegramEnv;
  whatsapp: WhatsAppEnv;
  sendSmoke: boolean;
  productionAudit: boolean;
  smokeText: string;
  workspaceId: string;
  channelId: string;
  messageId: string;
}

export interface ExternalRoomDoctorDeps {
  fetchImpl?: typeof fetch;
  listProductionSecrets?: () => Promise<ProductionSecret[]>;
  telegramService?: TelegramRoomService;
  whatsappService?: WhatsAppRoomService;
  recordExternalRoomMessageReceipt?: RecordExternalRoomMessageReceipt;
  resolveServiceSecrets?: ResolveServiceSecrets;
}

interface ProductionSecret {
  name: string;
  status?: string;
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

export function parseExternalRoomDoctorConfig(
  input: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
  } = {},
): ExternalRoomDoctorConfig {
  const env = loadEnv(input.env).telegram;
  const whatsapp = loadEnv(input.env).whatsapp;
  const argv = input.argv ?? process.argv.slice(2);
  return {
    telegram: env,
    whatsapp,
    sendSmoke: hasArg(argv, "--send-smoke"),
    productionAudit: hasArg(argv, "--production"),
    smokeText:
      argValue(argv, "--text") ??
      "ipop external-room doctor smoke: provider setup is reachable; reply in-thread to complete E2E proof.",
    workspaceId:
      argValue(argv, "--workspace-id")?.trim() ??
      input.env?.RELOAD_OWNER_WORKSPACE_ID?.trim() ??
      input.env?.RELOAD_MARKETING_OWNER_WORKSPACE_ID?.trim() ??
      "",
    channelId: argValue(argv, "--channel-id")?.trim() ?? "",
    messageId: argValue(argv, "--message-id")?.trim() ?? "",
  };
}

const REQUIRED_PRODUCTION_SECRETS: Record<ExternalRoomMessageProvider, string[]> = {
  telegram: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"],
  whatsapp: [
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "WHATSAPP_APP_SECRET",
  ],
};

async function defaultListProductionSecrets(): Promise<ProductionSecret[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("flyctl", ["secrets", "list", "-a", "reload-api"]);
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, _digest, status] = line.split(/[│|]/).map((part) => part.trim());
      return { name: name ?? "", status };
    })
    .filter((secret) => secret.name.length > 0);
}

async function productionSecretChecks(input: {
  listProductionSecrets: () => Promise<ProductionSecret[]>;
}): Promise<DoctorCheck[]> {
  let secrets: ProductionSecret[];
  try {
    secrets = await input.listProductionSecrets();
  } catch (error) {
    return [
      {
        name: "production-secrets",
        status: "fail",
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
  const deployed = new Map(secrets.map((secret) => [secret.name, secret.status ?? "unknown"]));
  return (Object.keys(REQUIRED_PRODUCTION_SECRETS) as ExternalRoomMessageProvider[]).map((provider) => {
    const required = REQUIRED_PRODUCTION_SECRETS[provider];
    const missing = required.filter((name) => !deployed.has(name));
    const present = required.filter((name) => deployed.has(name));
    if (missing.length > 0) {
      return {
        name: provider + "-production-secrets",
        status: "fail",
        message:
          "missing in production: " +
          missing.join(", ") +
          (present.length > 0 ? "; present: " + present.join(", ") : ""),
      };
    }
    return {
      name: provider + "-production-secrets",
      status: "pass",
      message:
        "present in production but not locally testable without provider credentials: " +
        present.map((name) => name + " (" + deployed.get(name) + ")").join(", "),
    };
  });
}

function missingEnvRemedy(provider: "telegram" | "whatsapp", missingEnv: string[]): string {
  if (missingEnv.length === 0) return "";
  if (provider === "telegram") {
    return [
      "remedy: set production secrets",
      "fly secrets set --app reload-api TELEGRAM_BOT_TOKEN=<bot-token> TELEGRAM_WEBHOOK_SECRET=<random-secret>",
      "then call Telegram setWebhook for " +
        PRODUCTION_API_BASE_URL +
        "/telegram/webhook with secret_token=$TELEGRAM_WEBHOOK_SECRET",
      "then run room:doctor -- --send-smoke --workspace-id <workspace-id> --channel-id <channel-id> --message-id <message-id>",
    ].join("; ");
  }
  return [
    "remedy: set production secrets",
    "fly secrets set --app reload-api WHATSAPP_ACCESS_TOKEN=<access-token> WHATSAPP_PHONE_NUMBER_ID=<phone-number-id> WHATSAPP_WEBHOOK_VERIFY_TOKEN=<verify-token> WHATSAPP_APP_SECRET=<app-secret>",
    "then configure Meta webhook callback " + PRODUCTION_API_BASE_URL + "/whatsapp/webhook",
    "with the same verify token and signed POSTs using X-Hub-Signature-256",
    "then run room:doctor -- --send-smoke --workspace-id <workspace-id> --channel-id <channel-id> --message-id <message-id>",
  ].join("; ");
}

function missingEnvCheck(provider: "telegram" | "whatsapp", missingEnv: string[]): DoctorCheck {
  return {
    name: provider + "-config",
    status: missingEnv.length === 0 ? "pass" : "fail",
    message:
      missingEnv.length === 0
        ? provider + " room config present"
        : provider + " room config missing: " + missingEnv.join(", ") + "; " + missingEnvRemedy(provider, missingEnv),
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

async function checkTelegramIdentity(input: {
  config: TelegramEnv;
  fetchImpl: typeof fetch;
}): Promise<DoctorCheck> {
  const token = input.config.botToken;
  if (!token)
    return { name: "telegram-identity", status: "fail", message: "TELEGRAM_BOT_TOKEN is missing" };
  const base = input.config.apiBaseUrl.replace(/\/+$/, "");
  try {
    const result = await jsonFetch({
      url: base + "/bot" + encodeURIComponent(token) + "/getMe",
      fetchImpl: input.fetchImpl,
    });
    const payload = result.payload as {
      ok?: boolean;
      result?: { id?: number; username?: string };
      description?: string;
    } | null;
    if (!result.ok || payload?.ok !== true) {
      return {
        name: "telegram-identity",
        status: "fail",
        message: payload?.description ?? "Telegram getMe failed with HTTP " + result.status,
      };
    }
    return {
      name: "telegram-identity",
      status: "pass",
      message:
        "Telegram bot reachable" +
        (payload.result?.username ? " (@" + payload.result.username + ")" : ""),
    };
  } catch (error) {
    return {
      name: "telegram-identity",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkWhatsAppSender(input: {
  config: WhatsAppEnv;
  fetchImpl: typeof fetch;
}): Promise<DoctorCheck> {
  const token = input.config.accessToken;
  const phoneNumberId = input.config.phoneNumberId;
  if (!token || !phoneNumberId) {
    return {
      name: "whatsapp-sender",
      status: "fail",
      message: "WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID are required",
    };
  }
  const base = input.config.apiBaseUrl.replace(/\/+$/, "");
  const url =
    base +
    "/" +
    encodeURIComponent(phoneNumberId) +
    "?fields=id,display_phone_number,verified_name";
  try {
    const result = await jsonFetch({
      url,
      fetchImpl: input.fetchImpl,
      init: { headers: { authorization: "Bearer " + token } },
    });
    const payload = result.payload as {
      id?: string;
      display_phone_number?: string;
      verified_name?: string;
      error?: { message?: string };
    } | null;
    if (!result.ok || !payload?.id) {
      return {
        name: "whatsapp-sender",
        status: "fail",
        message:
          payload?.error?.message ?? "WhatsApp sender lookup failed with HTTP " + result.status,
      };
    }
    return {
      name: "whatsapp-sender",
      status: "pass",
      message:
        "WhatsApp sender reachable" +
        (payload.verified_name ? " (" + payload.verified_name + ")" : "") +
        (payload.display_phone_number ? " " + payload.display_phone_number : ""),
    };
  } catch (error) {
    return {
      name: "whatsapp-sender",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkWhatsAppSignature(service: WhatsAppRoomService): DoctorCheck {
  const raw = JSON.stringify({ doctor: true });
  const missing = service.status().missingEnv.includes("WHATSAPP_APP_SECRET");
  if (missing)
    return {
      name: "whatsapp-signature",
      status: "fail",
      message: "WHATSAPP_APP_SECRET is missing",
    };
  const rejectsInvalid = !service.verifySignature(raw, "sha256=invalid");
  return {
    name: "whatsapp-signature",
    status: rejectsInvalid ? "pass" : "fail",
    message: rejectsInvalid
      ? "WhatsApp signature verifier rejects invalid signatures"
      : "WhatsApp signature verifier unexpectedly accepted an invalid signature",
  };
}

async function maybeSendTelegramSmoke(input: {
  service: TelegramRoomService;
  chatId?: string;
  text: string;
  enabled: boolean;
  workspaceId: string;
}): Promise<{ check: DoctorCheck; providerMessageId?: string; providerConversationId?: string }> {
  if (!input.enabled) {
    return {
      check: {
        name: "telegram-send-smoke",
        status: "warn",
        message: "skipped; pass --send-smoke to send a tagged Telegram message",
      },
    };
  }
  if (!input.chatId) {
    return {
      check: {
        name: "telegram-send-smoke",
        status: "fail",
        message: input.workspaceId
          ? "workspace Telegram destination is missing; connect telegram_room with TELEGRAM_CHAT_ID for workspace " +
            input.workspaceId +
            " or set TELEGRAM_ROOM_CHAT_ID"
          : "Telegram destination is missing; pass --workspace-id for a connected workspace or set TELEGRAM_ROOM_CHAT_ID",
      },
    };
  }
  const result = await input.service.send({ chatId: input.chatId, text: input.text });
  return result.status === "sent"
    ? {
        check: {
          name: "telegram-send-smoke",
          status: "pass",
          message: "sent Telegram smoke message id " + result.providerMessageId,
        },
        providerConversationId: result.chatId,
        providerMessageId: result.providerMessageId,
      }
    : { check: { name: "telegram-send-smoke", status: "fail", message: result.error } };
}

async function maybeSendWhatsAppSmoke(input: {
  service: WhatsAppRoomService;
  recipient?: string;
  text: string;
  enabled: boolean;
  workspaceId: string;
}): Promise<{ check: DoctorCheck; providerMessageId?: string; providerConversationId?: string }> {
  if (!input.enabled) {
    return {
      check: {
        name: "whatsapp-send-smoke",
        status: "warn",
        message: "skipped; pass --send-smoke to send a tagged WhatsApp message",
      },
    };
  }
  if (!input.recipient) {
    return {
      check: {
        name: "whatsapp-send-smoke",
        status: "fail",
        message: input.workspaceId
          ? "workspace WhatsApp destination is missing; connect whatsapp_room with WHATSAPP_RECIPIENT for workspace " +
            input.workspaceId +
            " or set WHATSAPP_ROOM_RECIPIENT"
          : "WhatsApp destination is missing; pass --workspace-id for a connected workspace or set WHATSAPP_ROOM_RECIPIENT",
      },
    };
  }
  const result = await input.service.send({
    recipient: input.recipient,
    text: input.text,
  });
  return result.status === "sent"
    ? {
        check: {
          name: "whatsapp-send-smoke",
          status: "pass",
          message: "sent WhatsApp smoke message id " + result.providerMessageId,
        },
        providerConversationId: result.recipient,
        providerMessageId: result.providerMessageId,
      }
    : { check: { name: "whatsapp-send-smoke", status: "fail", message: result.error } };
}

async function resolveWorkspaceDestination(input: {
  workspaceId: string;
  serviceKey: string;
  envKey: string;
  fallback: string | undefined;
  resolveServiceSecrets: ResolveServiceSecrets;
}): Promise<string | undefined> {
  if (input.workspaceId) {
    const secrets = await input.resolveServiceSecrets(input.workspaceId, input.serviceKey);
    const destination = secrets[input.envKey]?.trim();
    if (destination) return destination;
  }
  return input.fallback?.trim() || undefined;
}

async function maybeRecordSmokeReceipt(input: {
  provider: ExternalRoomMessageProvider;
  config: ExternalRoomDoctorConfig;
  providerConversationId?: string;
  providerMessageId?: string;
  recordExternalRoomMessageReceipt: RecordExternalRoomMessageReceipt;
}): Promise<DoctorCheck | null> {
  if (!input.providerConversationId || !input.providerMessageId) return null;
  if (!input.config.workspaceId || !input.config.channelId || !input.config.messageId) {
    return {
      name: input.provider + "-room-receipt",
      status: "warn",
      message:
        "not recorded; pass --workspace-id, --channel-id, and --message-id to correlate this smoke with the canonical room",
    };
  }
  try {
    await input.recordExternalRoomMessageReceipt({
      workspaceId: input.config.workspaceId,
      channelId: input.config.channelId,
      messageId: input.config.messageId,
      provider: input.provider,
      providerConversationId: input.providerConversationId,
      providerMessageId: input.providerMessageId,
    });
    return {
      name: input.provider + "-room-receipt",
      status: "pass",
      message:
        "recorded " +
        input.provider +
        " provider message " +
        input.providerMessageId +
        " for room message " +
        input.config.messageId,
    };
  } catch (error) {
    return {
      name: input.provider + "-room-receipt",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runExternalRoomDoctor(
  config: ExternalRoomDoctorConfig,
  deps: ExternalRoomDoctorDeps = {},
): Promise<DoctorCheck[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const listProductionSecrets = deps.listProductionSecrets ?? defaultListProductionSecrets;
  const telegramService = deps.telegramService ?? new TelegramRoomService(config.telegram);
  const whatsappService = deps.whatsappService ?? new WhatsAppRoomService(config.whatsapp);
  const resolveSecrets = deps.resolveServiceSecrets ?? resolveServiceSecrets;
  const recordExternalRoomMessageReceipt: RecordExternalRoomMessageReceipt =
    deps.recordExternalRoomMessageReceipt ??
    (async (...args) => {
      const mod = await import("../db/repositories/external-room-message-receipts.js");
      return mod.recordExternalRoomMessageReceipt(...args);
    });
  const checks: DoctorCheck[] = [];

  if (config.productionAudit) {
    checks.push(...(await productionSecretChecks({ listProductionSecrets })));
    if (!config.sendSmoke) {
      checks.push({
        name: "production-send-smoke",
        status: "warn",
        message:
          "production secret audit only; pass --send-smoke with provider credentials and a connected workspace to prove live send/reply",
      });
      return checks;
    }
  }

  checks.push(missingEnvCheck("telegram", telegramService.status().missingEnv));
  checks.push(await checkTelegramIdentity({ config: config.telegram, fetchImpl }));
  const telegramChatId = config.sendSmoke
    ? await resolveWorkspaceDestination({
        workspaceId: config.workspaceId,
        serviceKey: TELEGRAM_ROOM_CONNECTION_ID,
        envKey: TELEGRAM_WORKSPACE_CHAT_ID_KEY,
        fallback: config.telegram.roomChatId,
        resolveServiceSecrets: resolveSecrets,
      })
    : undefined;
  const telegramSmoke = await maybeSendTelegramSmoke({
    service: telegramService,
    chatId: telegramChatId,
    text: config.smokeText,
    enabled: config.sendSmoke,
    workspaceId: config.workspaceId,
  });
  checks.push(telegramSmoke.check);
  const telegramReceipt = await maybeRecordSmokeReceipt({
    provider: "telegram",
    config,
    providerConversationId: telegramSmoke.providerConversationId,
    providerMessageId: telegramSmoke.providerMessageId,
    recordExternalRoomMessageReceipt,
  });
  if (telegramReceipt) checks.push(telegramReceipt);

  checks.push(missingEnvCheck("whatsapp", whatsappService.status().missingEnv));
  checks.push(await checkWhatsAppSender({ config: config.whatsapp, fetchImpl }));
  checks.push(checkWhatsAppSignature(whatsappService));
  const whatsAppRecipient = config.sendSmoke
    ? await resolveWorkspaceDestination({
        workspaceId: config.workspaceId,
        serviceKey: WHATSAPP_ROOM_CONNECTION_ID,
        envKey: WHATSAPP_WORKSPACE_RECIPIENT_KEY,
        fallback: config.whatsapp.roomRecipient,
        resolveServiceSecrets: resolveSecrets,
      })
    : undefined;
  const whatsAppSmoke = await maybeSendWhatsAppSmoke({
    service: whatsappService,
    recipient: whatsAppRecipient,
    text: config.smokeText,
    enabled: config.sendSmoke,
    workspaceId: config.workspaceId,
  });
  checks.push(whatsAppSmoke.check);
  const whatsAppReceipt = await maybeRecordSmokeReceipt({
    provider: "whatsapp",
    config,
    providerConversationId: whatsAppSmoke.providerConversationId,
    providerMessageId: whatsAppSmoke.providerMessageId,
    recordExternalRoomMessageReceipt,
  });
  if (whatsAppReceipt) checks.push(whatsAppReceipt);

  return checks;
}

async function main(): Promise<void> {
  const checks = await runExternalRoomDoctor(parseExternalRoomDoctorConfig());
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
