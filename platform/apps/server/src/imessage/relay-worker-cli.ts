#!/usr/bin/env tsx
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { MacOsMessagesAdapter } from "./macos-adapter.js";

interface RelayJob {
  id: string;
  recipient: string;
  serviceName: string | null;
  text: string;
}

interface ClaimResponse {
  jobs?: RelayJob[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function apiUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
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
    const reason = payload?.error ? String(payload.error) : `${res.status} ${res.statusText}`;
    throw new Error(reason);
  }
  return payload as T;
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
      await postJson(apiUrl(input.baseUrl, `/imessage/relay/outbound/${job.id}/complete`), input.secret, {
        relayId: input.relayId,
        status: "sent",
      });
      console.log(`sent imessage relay job ${job.id} -> ${job.recipient}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await postJson(apiUrl(input.baseUrl, `/imessage/relay/outbound/${job.id}/complete`), input.secret, {
        relayId: input.relayId,
        status: "failed",
        error: message,
      });
      console.error(`failed imessage relay job ${job.id}: ${message}`);
    }
  }
  return jobs.length;
}

async function main(): Promise<void> {
  if (process.platform !== "darwin" && process.env.IMESSAGE_RELAY_ALLOW_NON_MAC !== "1") {
    throw new Error("iMessage relay worker must run on a logged-in macOS host with Messages access");
  }
  const baseUrl = process.env.IMESSAGE_RELAY_API_BASE?.trim() || "https://api.ipop.ai";
  const secret = required("IMESSAGE_RELAY_WEBHOOK_SECRET");
  const host = hostname();
  const relayId = process.env.IMESSAGE_RELAY_ID?.trim() || `mac-${host}`;
  const version = process.env.IMESSAGE_RELAY_VERSION?.trim() || null;
  const limit = Number(process.env.IMESSAGE_RELAY_CLAIM_LIMIT || "5");
  const leaseMs = Number(process.env.IMESSAGE_RELAY_LEASE_MS || "120000");
  const pollMs = Number(process.env.IMESSAGE_RELAY_POLL_MS || "5000");
  const once = process.argv.includes("--once");
  const adapter = new MacOsMessagesAdapter(process.env.IMESSAGE_OSASCRIPT_BIN || "osascript");

  let shouldContinue = true;
  while (shouldContinue) {
    const count = await runOnce({ baseUrl, secret, relayId, host, version, limit, leaseMs, adapter });
    if (once) {
      shouldContinue = false;
      continue;
    }
    if (count === 0) await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
