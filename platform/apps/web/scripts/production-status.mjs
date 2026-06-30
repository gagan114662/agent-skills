#!/usr/bin/env node
import { evaluateFreshness, normalizeSha } from "./production-freshness.mjs";

const DEFAULT_WEB_TARGET = "https://ipop.ai/";
const DEFAULT_API_VERSION_URL = "https://api.ipop.ai/version";

function jsonReplacer(_key, value) {
  return value instanceof Error ? value.message : value;
}

export function resolveApiVersionUrl(webTarget = DEFAULT_WEB_TARGET, explicit = process.env.PRODUCTION_API_VERSION_URL) {
  if (explicit && explicit.trim()) return explicit.trim();
  const url = new URL(webTarget);
  if (url.hostname === "ipop.ai" || url.hostname === "www.ipop.ai") return DEFAULT_API_VERSION_URL;
  return new URL("/version", url.origin).toString();
}

async function fetchText(fetcher, url) {
  const response = await fetcher(url, {
    headers: {
      "user-agent": "ipop-production-status/1.0",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText ?? ""}`.trim());
  return text;
}

function parseApiVersion(body) {
  try {
    const parsed = JSON.parse(body);
    return normalizeSha(parsed?.version);
  } catch {
    return null;
  }
}

export async function runProductionStatus({
  webTarget = process.env.PRODUCTION_WEB_URL || DEFAULT_WEB_TARGET,
  apiVersionUrl = resolveApiVersionUrl(webTarget),
  expectedSha = process.env.EXPECTED_WEB_SHA || process.env.GITHUB_SHA,
  fetcher = fetch,
} = {}) {
  const [webHtml, apiBody] = await Promise.all([
    fetchText(fetcher, webTarget),
    fetchText(fetcher, apiVersionUrl),
  ]);
  const web = evaluateFreshness({ html: webHtml, expectedSha });
  const hasExpectedSha = Boolean(normalizeSha(expectedSha));
  const webFailures = hasExpectedSha
    ? web.failures
    : web.failures.filter((failure) => !failure.startsWith("expected SHA is missing or malformed"));
  const apiSha = parseApiVersion(apiBody);
  const apiFailures = apiSha ? [] : ["API /version did not return a usable git SHA."];

  return {
    ok: webFailures.length === 0 && apiFailures.length === 0,
    expectedWebSha: web.expectedSha,
    web: {
      target: webTarget,
      sha: web.liveSha,
      ok: webFailures.length === 0,
      failures: webFailures,
    },
    api: {
      target: apiVersionUrl,
      sha: apiSha,
      ok: apiFailures.length === 0,
      matchesExpectedWebSha: Boolean(apiSha && web.expectedSha && apiSha.startsWith(web.expectedSha)),
      failures: apiFailures,
    },
  };
}

export function formatProductionStatus(result) {
  const lines = [
    `production status: ${result.ok ? "ok" : "not ok"}`,
    `- expected web SHA: ${result.expectedWebSha ?? "unknown"}`,
    `- web: ${result.web.sha ?? "missing"} @ ${result.web.target}`,
    `- api: ${result.api.sha ?? "missing"} @ ${result.api.target}`,
  ];
  if (result.api.sha && result.expectedWebSha && !result.api.matchesExpectedWebSha) {
    lines.push("- note: API SHA differs from expected web SHA; this is allowed for web-only deploys but must be visible.");
  }
  for (const failure of [...result.web.failures, ...result.api.failures]) lines.push(`- failure: ${failure}`);
  return lines.join("\n");
}

if (import.meta.url === "file://" + process.argv[1]) {
  runProductionStatus({ webTarget: process.argv[2] || undefined })
    .then((result) => {
      if (process.env.PRODUCTION_STATUS_JSON === "1") console.log(JSON.stringify(result, jsonReplacer, 2));
      else console.log(formatProductionStatus(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
