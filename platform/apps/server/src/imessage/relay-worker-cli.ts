#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MacOsMessagesAdapter } from "./macos-adapter.js";

const execFileAsync = promisify(execFile);

interface RelayJob {
  id: string;
  recipient: string;
  serviceName: string | null;
  text: string;
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
}

interface DoctorCheck {
  name: string;
  status: "pass" | "fail";
  message: string;
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
  };
}

async function checkOsascript(input: {
  osascriptBin: string;
  execFileImpl?: typeof execFileAsync;
}): Promise<DoctorCheck> {
  try {
    await (input.execFileImpl ?? execFileAsync)(input.osascriptBin, ["-e", "return \"ok\""]);
    return { name: "osascript", status: "pass", message: input.osascriptBin + " is runnable" };
  } catch (error) {
    return {
      name: "osascript",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runRelayDoctor(input: {
  config: RelayWorkerConfig;
  execFileImpl?: typeof execFileAsync;
  postJsonImpl?: typeof postJson;
}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(
    await checkOsascript({ osascriptBin: input.config.osascriptBin, execFileImpl: input.execFileImpl }),
  );
  try {
    await (input.postJsonImpl ?? postJson)(apiUrl(input.config.baseUrl, "/imessage/relay/heartbeat"), input.config.secret, {
      relayId: input.config.relayId,
      host: input.config.host,
      version: input.config.version,
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

async function runOnce(input: {
  baseUrl: string;
  secret: string;
  relayId: string;
  host: string;
  version: string | null;
  limit: number;
  leaseMs: number;
  adapter: MacOsMessagesAdapter;
}): Promise<number> {
  await postJson(apiUrl(input.baseUrl, "/imessage/relay/heartbeat"), input.secret, {
    relayId: input.relayId,
    host: input.host,
    version: input.version,
  });
  const claim = await postJson<ClaimResponse>(apiUrl(input.baseUrl, "/imessage/relay/outbound/claim"), input.secret, {
    relayId: input.relayId,
    limit: input.limit,
    leaseMs: input.leaseMs,
  });
  const jobs = claim.jobs ?? [];
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

  const adapter = new MacOsMessagesAdapter(config.osascriptBin);
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
