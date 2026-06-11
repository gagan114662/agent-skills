/**
 * Uptime check CLI (#108, ADR-0108) — `pnpm --filter @reload/server uptime:check`.
 *
 * The scheduled GitHub Action (`.github/workflows/uptime-check.yml`) runs this every 5 minutes against
 * the two public URLs (`api.ipop.ai`, `ipop.ai`). It probes each, then — using the pure {@link check}
 * decision core — **opens** a GitHub issue on failure, **noops** while an issue is already open (no
 * 5-minute spam), and **comments + closes** it on recovery.
 *
 * Fail-soft + self-guarding: with no `GITHUB_TOKEN` (a fork, or a local run) it still probes and
 * **exits non-zero if any target is down**, so the workflow goes red even when it cannot touch issues.
 * A probe error is *down*, never a crash. The token is read from the Actions env, passed as a bearer
 * header by the existing provider, and never logged.
 */
import { GitHubIssueProvider } from "../integrations/issues/github.js";
import type { IssueRef } from "../integrations/issues/types.js";
import {
  parseTargets,
  evaluateResponse,
  decideAlertAction,
  parseMarker,
  UPTIME_LABEL,
  type ProbeTarget,
  type ProbeResult,
  type OpenAlertIssue,
} from "./check.js";

/** A length cap so a full HTML page never lands in an issue body / the logs. */
const SNIPPET_MAX = 300;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Probe one URL. Any failure (timeout, DNS, reset) becomes a `status: null` ProbeResult, never a throw. */
async function probe(target: ProbeTarget, timeoutMs: number): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: controller.signal,
      redirect: "manual",
      headers: { "User-Agent": "reload-uptime-monitor" },
    });
    const text = await res.text().catch(() => "");
    return {
      status: res.status,
      bodySnippet: text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      status: null,
      bodySnippet: "",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `owner/repo` from `GITHUB_REPOSITORY` (set by Actions). */
function parseRepo(slug: string | undefined): { owner: string; repo: string } | null {
  const m = /^([^/]+)\/([^/]+)$/.exec((slug ?? "").trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

async function main(): Promise<void> {
  const targets = parseTargets(process.env.UPTIME_TARGETS);
  const timeoutMs = Number(process.env.UPTIME_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = parseRepo(process.env.GITHUB_REPOSITORY);
  const canAlert = Boolean(token && repo);

  if (!canAlert) {
    console.log("uptime:check — report-only (no GITHUB_TOKEN/GITHUB_REPOSITORY); probing without alerting");
  }

  const provider = new GitHubIssueProvider();

  // Find the currently-open alerts once, then map each to its target via the body marker (the dedupe key).
  const openByTarget = new Map<string, OpenAlertIssue>();
  if (canAlert) {
    const open = await provider.listOpenIssuesByLabel(repo!, token, UPTIME_LABEL);
    for (const issue of open) {
      const marker = parseMarker(issue.body);
      if (marker && !openByTarget.has(marker)) openByTarget.set(marker, { number: issue.number, marker });
    }
  }

  let anyDown = false;
  for (const target of targets) {
    const result = await probe(target, timeoutMs);
    const verdict = evaluateResponse(result, target);
    const open = openByTarget.get(target.id) ?? null;
    const decision = decideAlertAction(target, verdict, result, open);

    console.log(`${verdict.ok ? "✓" : "✗"} ${target.name} — ${verdict.detail} → ${decision.action}`);
    if (!verdict.ok) anyDown = true;

    if (!canAlert) continue;
    const ref = (n: number): IssueRef => ({ source: "github", owner: repo!.owner, repo: repo!.repo, number: n, raw: `${repo!.owner}/${repo!.repo}#${n}` });
    try {
      if (decision.action === "open") {
        const created = await provider.createIssue(repo!, token, {
          title: decision.title,
          body: decision.body,
          labels: decision.labels,
        });
        console.log(`  → opened alert issue #${created.number}`);
      } else if (decision.action === "recover") {
        await provider.postComment(ref(decision.issueNumber), token, decision.comment);
        await provider.closeIssue(ref(decision.issueNumber), token);
        console.log(`  → recovered: commented + closed issue #${decision.issueNumber}`);
      }
    } catch (err) {
      // Never let an issue-side failure mask a probe result — log and keep the down signal.
      console.error(`  ! issue action failed for ${target.name}:`, err instanceof Error ? err.message : err);
    }
  }

  // The workflow itself is a signal: red when anything is down (even in report-only mode).
  process.exitCode = anyDown ? 1 : 0;
}

main().catch((err) => {
  console.error("✗ uptime:check — unexpected failure:", err instanceof Error ? err.message : err);
  process.exit(1);
});
