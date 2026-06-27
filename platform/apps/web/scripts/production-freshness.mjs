#!/usr/bin/env node
/**
 * Production deploy freshness probe (#1321). Fetches the live public homepage and fails loudly when
 * production is stale: wrong/missing build stamp, old landing copy still present, or the current
 * message-first homepage contract absent. Dependency-free so it can run in GitHub Actions and locally.
 */

const SHA_RE = /^[0-9a-f]{7,64}$/;

export const DEFAULT_REQUIRED_TEXT = ["Make marketing pop.", "marketing team in your messages"];
export const DEFAULT_FORBIDDEN_TEXT = [
  "The marketing agency of AI agents",
  "Start free",
  "Watch live demo",
];

export function normalizeSha(raw) {
  if (typeof raw !== "string") return null;
  const sha = raw.trim().toLowerCase();
  return SHA_RE.test(sha) ? sha : null;
}

export function extractBuildSha(html) {
  if (typeof html !== "string") return null;
  const match = /<meta\s+name=["']reload-build-sha["']\s+content=["']([^"']+)["']\s*\/?>/i.exec(html);
  return normalizeSha(match?.[1]);
}

export function sameCommit(a, b) {
  const left = normalizeSha(a);
  const right = normalizeSha(b);
  return Boolean(left && right && (left.startsWith(right) || right.startsWith(left)));
}

export function evaluateFreshness({ html, expectedSha, requiredText = DEFAULT_REQUIRED_TEXT, forbiddenText = DEFAULT_FORBIDDEN_TEXT }) {
  const liveSha = extractBuildSha(html);
  const expected = normalizeSha(expectedSha);
  const failures = [];

  if (!expected) failures.push("expected SHA is missing or malformed; pass EXPECTED_WEB_SHA or run from GitHub Actions.");
  if (!liveSha) failures.push("live homepage has no <meta name=\"reload-build-sha\"> stamp.");
  if (expected && liveSha && !sameCommit(expected, liveSha)) {
    failures.push(`live homepage is on ${liveSha}, expected ${expected}.`);
  }

  for (const text of requiredText) {
    if (!html.includes(text)) failures.push(`live homepage is missing required text: ${JSON.stringify(text)}.`);
  }
  for (const text of forbiddenText) {
    if (html.includes(text)) failures.push(`live homepage still contains stale text: ${JSON.stringify(text)}.`);
  }

  return { ok: failures.length === 0, expectedSha: expected, liveSha, failures };
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "ipop-deploy-freshness/1.0",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return text;
}

export async function runProductionFreshness({
  target = process.env.PRODUCTION_WEB_URL || "https://ipop.ai/",
  expectedSha = process.env.EXPECTED_WEB_SHA || process.env.GITHUB_SHA,
  fetcher = fetchText,
} = {}) {
  const html = await fetcher(target);
  return { target, ...evaluateFreshness({ html, expectedSha }) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] || process.env.PRODUCTION_WEB_URL || "https://ipop.ai/";
  runProductionFreshness({ target })
    .then((result) => {
      if (result.ok) {
        console.log(`production fresh: ${result.target} is on ${result.liveSha}`);
        return;
      }
      console.error(`production stale: ${result.target}`);
      for (const failure of result.failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
