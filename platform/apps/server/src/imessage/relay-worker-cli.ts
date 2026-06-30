#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MacOsMessagesAdapter } from "./macos-adapter.js";

const execFileAsync = promisify(execFile);

interface RelayJob {
  id: string;
  workspaceId: string;
  channelId: string | null;
  messageId: string | null;
  purpose: "verification" | "room" | "notification";
  recipient: string;
  serviceName: string | null;
  text: string;
  receipt: string | null;
}

interface ClaimResponse {
  jobs?: RelayJob[];
}

interface RelayWorkerConfig {
  baseUrl: string;
  secret: string;
  host: string;
  relayId: string;
  version: string | null;
  limit: number;
  leaseMs: number;
  pollMs: number;
  once: boolean;
  doctor: boolean;
  osascriptBin: string;
  sqliteBin: string;
  inboundEnabled: boolean;
  messagesDbPath: string;
  stateFile: string;
  inboundLimit: number;
  doctorTimeoutMs: number;
}

interface DoctorCheck {
  name: string;
  status: "pass" | "fail";
  message: string;
}

const MESSAGES_AUTOMATION_REMEDY =
  "Allow this terminal/Codex process to control Messages in System Settings > Privacy & Security > Automation, then keep Messages open and signed in.";
const MESSAGES_DB_REMEDY =
  "Grant Full Disk Access to this terminal/Codex process in System Settings > Privacy & Security > Full Disk Access, or set IMESSAGE_MESSAGES_DB_PATH to a readable Messages chat.db copy.";

export interface RelayTrackedReceipt {
  workspaceId: string;
  recipient: string;
  receipt: string;
  lastSeenRowId: number;
  updatedAt: string;
}

export interface RelayWorkerState {
  trackedReceipts: Record<string, RelayTrackedReceipt>;
}

export interface InboundMessageCandidate {
  rowId: number;
  sender: string;
  text: string;
}

export interface InboundRelayDelivery {
  rowId: number;
  payload: {
    workspaceId: string;
    receipt: string;
    sender: string;
    text: string;
  };
}

function requiredFrom(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + " is required");
  return value;
}

function apiUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : base + "/").toString();
}

async function postJson<T>(url: string, secret: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ipop-imessage-relay-secret": secret,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const reason = payload?.error ? String(payload.error) : res.status + " " + res.statusText;
    throw new Error(reason);
  }
  return payload as T;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function parseRelayWorkerConfig(input: {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  platform?: NodeJS.Platform;
  host?: string;
} = {}): RelayWorkerConfig {
  const env = input.env ?? process.env;
  const argv = input.argv ?? process.argv.slice(2);
  const platform = input.platform ?? process.platform;
  if (platform !== "darwin" && env.IMESSAGE_RELAY_ALLOW_NON_MAC !== "1") {
    throw new Error("iMessage relay worker must run on a logged-in macOS host with Messages access");
  }
  const host = input.host ?? hostname();
  return {
    baseUrl: env.IMESSAGE_RELAY_API_BASE?.trim() || "https://api.ipop.ai",
    secret: requiredFrom(env, "IMESSAGE_RELAY_WEBHOOK_SECRET"),
    host,
    relayId: env.IMESSAGE_RELAY_ID?.trim() || "mac-" + host,
    version: env.IMESSAGE_RELAY_VERSION?.trim() || null,
    limit: positiveNumber(env.IMESSAGE_RELAY_CLAIM_LIMIT, 5),
    leaseMs: positiveNumber(env.IMESSAGE_RELAY_LEASE_MS, 120_000),
    pollMs: positiveNumber(env.IMESSAGE_RELAY_POLL_MS, 5_000),
    once: argv.includes("--once"),
    doctor: argv.includes("--doctor"),
    osascriptBin: env.IMESSAGE_OSASCRIPT_BIN || "osascript",
    sqliteBin: env.IMESSAGE_SQLITE_BIN || "sqlite3",
    inboundEnabled: envFlag(env, "IMESSAGE_RELAY_INBOUND_ENABLED", true),
    messagesDbPath: env.IMESSAGE_MESSAGES_DB_PATH?.trim() || join(homedir(), "Library", "Messages", "chat.db"),
    stateFile: env.IMESSAGE_RELAY_STATE_FILE?.trim() || join(homedir(), ".ipop", "imessage-relay-state.json"),
    inboundLimit: positiveNumber(env.IMESSAGE_RELAY_INBOUND_LIMIT, 25),
    doctorTimeoutMs: positiveNumber(env.IMESSAGE_RELAY_DOCTOR_TIMEOUT_MS, 10_000),
  };
}

function execTimedOut(error: unknown): boolean {
  const detail = error as { killed?: boolean; signal?: string; message?: string };
  return Boolean(
    detail.killed ||
      detail.signal === "SIGTERM" ||
      detail.signal === "SIGKILL" ||
      (detail.message && /timed out|ETIMEDOUT|SIGTERM|SIGKILL/i.test(detail.message)),
  );
}

function withRemedy(message: string, remedy: string): string {
  return message.includes(remedy) ? message : message + "; remedy: " + remedy;
}

async function execFileCheck(input: {
  osascriptBin: string;
  args: string[];
  timeoutMs: number;
  label: string;
  execFileImpl?: typeof execFileAsync;
}) {
  try {
    return await (input.execFileImpl ?? execFileAsync)(input.osascriptBin, input.args, {
      timeout: input.timeoutMs,
      killSignal: "SIGTERM",
    });
  } catch (error) {
    if (execTimedOut(error)) {
      throw new Error(input.label + " timed out after " + input.timeoutMs + "ms");
    }
    throw error;
  }
}

async function checkOsascript(input: {
  osascriptBin: string;
  timeoutMs: number;
  execFileImpl?: typeof execFileAsync;
}): Promise<DoctorCheck> {
  try {
    await execFileCheck({
      osascriptBin: input.osascriptBin,
      args: ["-e", "return \"ok\""],
      timeoutMs: input.timeoutMs,
      label: "osascript",
      execFileImpl: input.execFileImpl,
    });
    return { name: "osascript", status: "pass", message: input.osascriptBin + " is runnable" };
  } catch (error) {
    return {
      name: "osascript",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkMessagesAccess(input: {
  osascriptBin: string;
  timeoutMs: number;
  execFileImpl?: typeof execFileAsync;
}): Promise<DoctorCheck> {
  try {
    const result = await execFileCheck({
      osascriptBin: input.osascriptBin,
      args: ["-e", "tell application \"Messages\" to count services"],
      timeoutMs: input.timeoutMs,
      label: "Messages AppleScript access",
      execFileImpl: input.execFileImpl,
    });
    const serviceCount = String(result.stdout ?? "").trim();
    return {
      name: "messages-access",
      status: "pass",
      message: "Messages AppleScript access is available (" + (serviceCount || "unknown") + " service(s) visible)",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "messages-access",
      status: "fail",
      message: withRemedy(message, MESSAGES_AUTOMATION_REMEDY),
    };
  }
}

async function checkMessagesDb(input: { adapter: MacOsMessagesAdapter; dbPath: string }): Promise<DoctorCheck> {
  if (!existsSync(input.dbPath)) {
    return {
      name: "messages-db",
      status: "fail",
      message: "Messages chat database not found at " + input.dbPath,
    };
  }
  try {
    const rowId = await input.adapter.latestMessageRowId({ dbPath: input.dbPath });
    return {
      name: "messages-db",
      status: "pass",
      message: "Messages chat database is readable (latest row " + rowId + ")",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: "messages-db",
      status: "fail",
      message: withRemedy(message, MESSAGES_DB_REMEDY),
    };
  }
}

export async function runRelayDoctor(input: {
  config: RelayWorkerConfig;
  execFileImpl?: typeof execFileAsync;
  postJsonImpl?: typeof postJson;
  adapter?: MacOsMessagesAdapter;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(
    await checkOsascript({
      osascriptBin: input.config.osascriptBin,
      timeoutMs: input.config.doctorTimeoutMs,
      execFileImpl: input.execFileImpl,
    }),
  );
  const messagesAccess = await checkMessagesAccess({
    osascriptBin: input.config.osascriptBin,
    timeoutMs: input.config.doctorTimeoutMs,
    execFileImpl: input.execFileImpl,
  });
  checks.push(messagesAccess);
  let messagesDbAccess: "unknown" | "ok" | "failed" = "unknown";
  if (input.config.inboundEnabled) {
    const messagesDb = await checkMessagesDb({
      adapter: input.adapter ?? new MacOsMessagesAdapter(input.config.osascriptBin, input.config.sqliteBin),
      dbPath: input.config.messagesDbPath,
    });
    messagesDbAccess = messagesDb.status === "pass" ? "ok" : "failed";
    checks.push(messagesDb);
  }
  try {
    await (input.postJsonImpl ?? postJson)(apiUrl(input.config.baseUrl, "/imessage/relay/heartbeat"), input.config.secret, {
      relayId: input.config.relayId,
      host: input.config.host,
      version: input.config.version,
      messagesAccess: messagesAccess.status === "pass" ? "ok" : "failed",
      messagesDbAccess,
    });
    checks.push({
      name: "api-heartbeat",
      status: "pass",
      message: "signed heartbeat accepted by " + input.config.baseUrl,
    });
  } catch (error) {
    checks.push({
      name: "api-heartbeat",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return checks;
}

function emptyState(): RelayWorkerState {
  return { trackedReceipts: {} };
}

export function normalizeRelayRecipient(raw: string): string {
  return raw.trim().toLowerCase();
}

export function rememberSentRelayJob(state: RelayWorkerState, job: RelayJob, lastSeenRowId: number, now = new Date()): RelayWorkerState {
  if (!job.receipt || !job.workspaceId || !job.recipient.trim()) return state;
  const key = normalizeRelayRecipient(job.recipient);
  return {
    trackedReceipts: {
      ...state.trackedReceipts,
      [key]: {
        workspaceId: job.workspaceId,
        recipient: job.recipient,
        receipt: job.receipt,
        lastSeenRowId: Math.max(0, Math.floor(lastSeenRowId)),
        updatedAt: now.toISOString(),
      },
    },
  };
}

export function buildInboundRelayDeliveries(
  state: RelayWorkerState,
  candidates: InboundMessageCandidate[],
): { deliveries: InboundRelayDelivery[]; state: RelayWorkerState } {
  let nextState = state;
  const deliveries: InboundRelayDelivery[] = [];
  for (const candidate of candidates.sort((a, b) => a.rowId - b.rowId)) {
    const key = normalizeRelayRecipient(candidate.sender);
    const tracked = nextState.trackedReceipts[key];
    if (!tracked || candidate.rowId <= tracked.lastSeenRowId || !candidate.text.trim()) continue;
    deliveries.push({
      rowId: candidate.rowId,
      payload: {
        workspaceId: tracked.workspaceId,
        receipt: tracked.receipt,
        sender: candidate.sender,
        text: candidate.text,
      },
    });
    nextState = {
      trackedReceipts: {
        ...nextState.trackedReceipts,
        [key]: {
          ...tracked,
          lastSeenRowId: candidate.rowId,
          updatedAt: new Date().toISOString(),
        },
      },
    };
  }
  return { deliveries, state: nextState };
}

async function loadState(path: string): Promise<RelayWorkerState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<RelayWorkerState>;
    return parsed && typeof parsed === "object" && parsed.trackedReceipts ? (parsed as RelayWorkerState) : emptyState();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return emptyState();
    throw error;
  }
}

async function saveState(path: string, state: RelayWorkerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function syncInboundReplies(input: {
  baseUrl: string;
  secret: string;
  stateFile: string;
  messagesDbPath: string;
  inboundLimit: number;
  adapter: MacOsMessagesAdapter;
}): Promise<number> {
  const state = await loadState(input.stateFile);
  const tracked = Object.values(state.trackedReceipts);
  if (tracked.length === 0) return 0;
  const afterRowId = Math.min(...tracked.map((entry) => entry.lastSeenRowId));
  const candidates = await input.adapter.inboundMessagesAfter({
    dbPath: input.messagesDbPath,
    recipients: tracked.map((entry) => entry.recipient),
    afterRowId,
    limit: input.inboundLimit,
  });
  const built = buildInboundRelayDeliveries(state, candidates);
  let sent = 0;
  let nextState = state;
  for (const delivery of built.deliveries) {
    try {
      await postJson(apiUrl(input.baseUrl, "/imessage/relay/inbound"), input.secret, delivery.payload);
      sent += 1;
      const key = normalizeRelayRecipient(delivery.payload.sender);
      const tracked = nextState.trackedReceipts[key];
      if (tracked) {
        nextState = {
          trackedReceipts: {
            ...nextState.trackedReceipts,
            [key]: {
              ...tracked,
              lastSeenRowId: delivery.rowId,
              updatedAt: new Date().toISOString(),
            },
          },
        };
      }
      console.log("relayed inbound iMessage row " + delivery.rowId + " from " + delivery.payload.sender);
    } catch (error) {
      console.error(
        "failed inbound iMessage row " +
          delivery.rowId +
          ": " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (sent > 0) await saveState(input.stateFile, nextState);
  return sent;
}

async function runOnce(input: {
  baseUrl: string;
  secret: string;
  relayId: string;
  host: string;
  version: string | null;
  limit: number;
  leaseMs: number;
  adapter: MacOsMessagesAdapter;
  inboundEnabled: boolean;
  messagesDbPath: string;
  stateFile: string;
  inboundLimit: number;
}): Promise<number> {
  let messagesDbAccess: "ok" | "failed" | undefined;
  if (input.inboundEnabled) {
    try {
      await input.adapter.latestMessageRowId({ dbPath: input.messagesDbPath });
      messagesDbAccess = "ok";
    } catch {
      messagesDbAccess = "failed";
    }
  }
  await postJson(apiUrl(input.baseUrl, "/imessage/relay/heartbeat"), input.secret, {
    relayId: input.relayId,
    host: input.host,
    version: input.version,
    ...(messagesDbAccess ? { messagesDbAccess } : {}),
  });
  const claim = await postJson<ClaimResponse>(apiUrl(input.baseUrl, "/imessage/relay/outbound/claim"), input.secret, {
    relayId: input.relayId,
    limit: input.limit,
    leaseMs: input.leaseMs,
  });
  const jobs = claim.jobs ?? [];
  let state = input.inboundEnabled ? await loadState(input.stateFile) : emptyState();
  for (const job of jobs) {
    try {
      await input.adapter.send({
        recipient: job.recipient,
        text: job.text,
        serviceName: job.serviceName ?? undefined,
      });
      await postJson(apiUrl(input.baseUrl, "/imessage/relay/outbound/" + job.id + "/complete"), input.secret, {
        relayId: input.relayId,
        status: "sent",
      });
      if (input.inboundEnabled) {
        try {
          const lastSeenRowId = await input.adapter.latestMessageRowId({ dbPath: input.messagesDbPath });
          state = rememberSentRelayJob(state, job, lastSeenRowId);
          await saveState(input.stateFile, state);
        } catch (error) {
          console.error(
            "sent imessage relay job " +
              job.id +
              " but could not track inbound replies: " +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }
      console.log("sent imessage relay job " + job.id + " -> " + job.recipient);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postJson(apiUrl(input.baseUrl, "/imessage/relay/outbound/" + job.id + "/complete"), input.secret, {
        relayId: input.relayId,
        status: "failed",
        error: message,
      });
      console.error("failed imessage relay job " + job.id + ": " + message);
    }
  }
  if (input.inboundEnabled) {
    try {
      await syncInboundReplies(input);
    } catch (error) {
      console.error("iMessage inbound sync failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return jobs.length;
}

async function main(): Promise<void> {
  const config = parseRelayWorkerConfig();
  if (config.doctor) {
    const checks = await runRelayDoctor({ config });
    for (const check of checks) console.log(check.status.toUpperCase() + " " + check.name + ": " + check.message);
    if (checks.some((check) => check.status === "fail")) process.exitCode = 1;
    return;
  }

  const adapter = new MacOsMessagesAdapter(config.osascriptBin, config.sqliteBin);
  let shouldContinue = true;
  while (shouldContinue) {
    const count = await runOnce({ ...config, adapter });
    if (config.once) {
      shouldContinue = false;
      continue;
    }
    if (count === 0) await sleep(config.pollMs);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
