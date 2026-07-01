/**
 * Self-QA run CLI (#171, ADR-0171) — `pnpm --filter @reload/server selfqa:run -- --suite smoke|full`.
 *
 * The scheduled GitHub Action (`.github/workflows/selfqa-nightly.yml`) runs the full pass nightly, and
 * `fly-deploy.yml` runs the smoke subset post-deploy, both against the live product. It drives the
 * synthetic-user catalog through the chosen headless driver, classifies the failures into structured
 * findings, and — using the SAME #57 `GitHubIssueProvider` the uptime monitor (#108) uses — **opens** a
 * deduped issue on a first-seen finding, **comments** when one is already open (the `<!-- selfqa:<sig> -->`
 * body marker is the dedup key), and never spams. Critical findings also page the owner (#148, opt-in).
 *
 * Fail-soft + self-guarding: with no `GITHUB_TOKEN` it still runs and **exits non-zero on any critical
 * finding**, so the workflow goes red even when it cannot touch issues. A driver/probe error is a *finding*,
 * never a crash. The token is read from the Actions env, passed as a bearer header by the provider, and
 * never logged.
 */
import { GitHubIssueProvider } from "../integrations/issues/github.js";
import { parseIssueRef } from "../integrations/issues/types.js";
import { checksForSuite } from "./catalog.js";
import { classifyResults } from "./classify.js";
import { summarize } from "./render.js";
import { resolveDriverAsync } from "./driver.js";
import { githubReporter, reportFindings, type IssueClient } from "./bridge.js";
import { parseSelfqaMarker } from "./render.js";
import type { QaFinding, QaSuite, RawCheckResult } from "./types.js";
import { DEFAULT_PUBLIC_APP_ORIGIN } from "../product-origins.js";

const SELFQA_LABEL = "selfqa";

/** Parse `--suite` / `--target` from argv (after the `--` separator pnpm forwards). */
function parseArgs(argv: string[]): { suite: QaSuite; target: string } {
  let suite: QaSuite = "smoke";
  let target = process.env.SELFQA_TARGET ?? DEFAULT_PUBLIC_APP_ORIGIN;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--suite" && (argv[i + 1] === "smoke" || argv[i + 1] === "full")) suite = argv[++i] as QaSuite;
    else if (argv[i] === "--target" && argv[i + 1]) target = argv[++i]!;
  }
  return { suite, target };
}

/** Parse `owner/repo` from `GITHUB_REPOSITORY` (set by Actions). */
function parseRepo(slug: string | undefined): { owner: string; repo: string } | null {
  const m = /^([^/]+)\/([^/]+)$/.exec((slug ?? "").trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Best-effort owner page for a critical finding, reusing the #148 PagerService (opt-in, lazy DB). */
async function pageOwner(finding: QaFinding): Promise<void> {
  const slug = process.env.RELIABILITY_PAGE_WORKSPACE_SLUG;
  if (!slug) return;
  try {
    const [{ getWorkspaceBySlug }, { createPagerService }, { resolveReliabilityCaps }, { loadConfig }] =
      await Promise.all([
        import("../db/repositories/workspaces.js"),
        import("../reliability/default.js"),
        import("../reliability/caps.js"),
        import("../config/loader.js"),
      ]);
    const ws = await getWorkspaceBySlug(slug);
    if (!ws || !resolveReliabilityCaps(loadConfig(ws.id).reliability).enabled) return;
    await createPagerService(console as never).page({
      workspaceId: ws.id,
      source: "selfqa",
      incidentId: null,
      kind: "selfqa_critical",
      severity: "critical",
      lastPagedAt: null,
      ackedAt: null,
      subject: `[ipop] self-QA critical: ${finding.title}`,
      body: `The synthetic QA user hit a critical failure on \`${finding.surface}\` (check \`${finding.checkId}\`).`,
    });
  } catch (err) {
    console.error("  ! self-QA owner-page skipped:", err instanceof Error ? err.message : err);
  }
}

async function main(): Promise<void> {
  const { suite, target } = parseArgs(process.argv.slice(2));
  // The CLI defaults to the HTTP smoke driver (a real probe with no browser binary); `playwright` opts in.
  const driver = await resolveDriverAsync(process.env.SELFQA_DRIVER ?? "http");
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const repo = parseRepo(process.env.GITHUB_REPOSITORY);
  const canFile = Boolean(token && repo);

  console.log(`selfqa:run — suite=${suite} target=${target} driver=${process.env.SELFQA_DRIVER ?? "http"} ` +
    `${canFile ? "(filing enabled)" : "(report-only: no GITHUB_TOKEN/GITHUB_REPOSITORY)"}`);

  // Run the suite's checks.
  const checks = checksForSuite(suite);
  const results: RawCheckResult[] = [];
  for (const check of checks) {
    try {
      results.push(await driver.run(check, { target }));
    } catch (err) {
      results.push({ checkId: check.id, ok: false, actual: `driver error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  const findings = classifyResults(results, checks);
  const summary = summarize(suite, target, results, findings);

  for (const f of findings) {
    console.log(`✗ [${f.severity}] ${f.surface}/${f.checkId} — ${f.title}`);
  }
  console.log(`selfqa:run — ${summary.checksFailed}/${summary.checksTotal} checks failed (${summary.criticalCount} critical)`);

  // File deduped issues (when a token is present) + page the owner for criticals.
  if (canFile) {
    const provider = new GitHubIssueProvider();
    // Pre-read the open selfqa issues and map each one's body marker → its ref (the dedup index).
    const existingByMarker = new Map<string, string>();
    try {
      for (const issue of await provider.listOpenIssuesByLabel(repo!, token, SELFQA_LABEL)) {
        const sig = parseSelfqaMarker(issue.body);
        if (sig && !existingByMarker.has(sig)) {
          existingByMarker.set(sig, `github:${repo!.owner}/${repo!.repo}#${issue.number}`);
        }
      }
    } catch (err) {
      console.error("  ! could not list open selfqa issues:", err instanceof Error ? err.message : err);
    }
    const client: IssueClient = {
      createIssue: async (input) => {
        const created = await provider.createIssue(repo!, token, input);
        return { number: created.number, ref: created.ref };
      },
      comment: async (ref, body) => void (await provider.postComment(parseIssueRef(ref), token, body)),
    };
    const out = await reportFindings(findings, {
      reporter: githubReporter({ client, existingByMarker }),
      target,
      workspaceSlug: process.env.SELFQA_WORKSPACE_SLUG ?? "selfqa-system",
      pageOwner,
    });
    console.log(`selfqa:run — filed/updated ${out.reported} issue(s), paged ${out.paged} owner(s)`);
  } else {
    // Report-only still pages the owner for criticals when configured (it does not need a repo token).
    for (const f of findings.filter((x) => x.severity === "critical")) await pageOwner(f);
  }

  // The workflow itself is a signal: red when any critical bug is open (even in report-only mode).
  process.exitCode = summary.criticalCount > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("✗ selfqa:run — unexpected failure:", err instanceof Error ? err.message : err);
  process.exit(1);
});
