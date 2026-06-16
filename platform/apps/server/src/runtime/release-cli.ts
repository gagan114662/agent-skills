/**
 * `node dist/runtime/release-cli.js` — the Fly `[deploy] release_command` (#273).
 *
 * Runs the FULL release gate on a one-off VM booted from the NEW image BEFORE any traffic shifts. A
 * non-zero exit aborts the rollout and Fly keeps the CURRENT (healthy) release serving — so the gate
 * IS the automatic rollback. This is what lets shipping a change require no manual terminal step: no
 * human runs `flyctl deploy` (the CI `fly-deploy.yml` does) and no human runs `db:migrate` (gate 0
 * below does, safely). Three gates, in order, fail-fast:
 *
 *   0. MIGRATIONS — apply pending DB migrations (`migrate up`). Running them HERE, before the cutover,
 *      means a bad migration aborts the deploy with the old code + schema still live, instead of
 *      crash-looping freshly-rolled machines (the failure mode of migrate-on-boot). Migrations are
 *      additive/forward-compatible, so the still-running old code is unaffected by an applied migration.
 *      (The boot-time migrate-on-deploy in docker-entrypoint.sh stays as an idempotent no-op safety net
 *      for local/compose; on Fly this gate is the authority and the boot run finds nothing pending.)
 *   1. PREFLIGHT (#238) — assert host posture: bash/git/claude on PATH + a writable workspace root.
 *   2. SMOKE (#166) — provision a per-session workspace + spawn ONE real demo-harness session E2E.
 *
 * Pure-ish + injectable: {@link runReleaseGates} takes fake migrate/preflight/smoke fns so a unit test
 * can pin the ordering + fail-fast guarantee without a DB or a spawn. The real wiring runs at the bottom.
 */
import { runMigrations } from "../db/migrate.js";
import { runDemoSmoke, type SmokeResult } from "./smoke-demo.js";
import { defaultPreflight } from "./default.js";
import type { PreflightReport } from "./preflight.js";

export type ReleaseGate = "migrations" | "preflight" | "smoke";

export interface ReleaseGateResult {
  ok: boolean;
  /** The first gate that failed (undefined when ok). */
  failedGate?: ReleaseGate;
  /** Human-readable, secret-free outcome line. */
  reason: string;
}

export interface ReleaseDeps {
  /** Apply pending migrations; defaults to the real {@link runMigrations}("up"). */
  migrate?: () => Promise<void>;
  /** Host-posture preflight; defaults to {@link defaultPreflight}. */
  preflight?: () => PreflightReport;
  /** End-to-end demo-harness smoke; defaults to {@link runDemoSmoke}. */
  smoke?: () => Promise<SmokeResult>;
  /** Sink for the secret-free progress lines (console.log by default). */
  log?: (line: string) => void;
}

export async function runReleaseGates(deps: ReleaseDeps = {}): Promise<ReleaseGateResult> {
  const migrate = deps.migrate ?? (() => runMigrations("up"));
  const preflight = deps.preflight ?? defaultPreflight;
  const smoke = deps.smoke ?? (() => runDemoSmoke());
  const log = deps.log ?? ((line: string) => console.log(line));

  // Gate 0 — migrations. Failure here aborts the deploy with the previous release untouched.
  try {
    log("[release] applying pending database migrations (migrate up)…");
    await migrate();
    log("[release] migrations OK — schema is up to date.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failedGate: "migrations",
      reason:
        `migration failed: ${msg}. Aborting deploy — the current release keeps serving (automatic ` +
        `rollback); no traffic was shifted to the new schema. Fix the migration (or its paired .down.sql) and re-push.`,
    };
  }

  // Gate 1 — preflight (#238). The report is content-free (names + statuses only), so it is safe to log.
  const report = preflight();
  for (const c of report.checks) log(`[preflight] ${c.status.toUpperCase()} ${c.name}: ${c.message}`);
  if (!report.ok) {
    const failed = report.checks.filter((c) => c.status === "fail");
    for (const c of failed) if (c.remedy) log(`[preflight] remedy (${c.name}): ${c.remedy}`);
    return {
      ok: false,
      failedGate: "preflight",
      reason:
        `preflight failed — ${failed.map((c) => c.name).join(", ")}. Aborting deploy: the agent image is ` +
        `missing a required tool or a writable workspace root (#238).`,
    };
  }
  log("[preflight] OK — required tools present and the per-session workspace root is writable.");

  // Gate 2 — smoke (#166). Provision + spawn a real demo session end-to-end.
  const res = await smoke();
  log(`[smoke] ${res.reason}`);
  if (!res.ok) {
    return {
      ok: false,
      failedGate: "smoke",
      reason:
        `smoke failed — status=${res.status} exit=${res.exitCode} sawMarker=${res.sawMarker}. ` +
        `Aborting deploy: the image cannot run an agent session end-to-end (#166).`,
    };
  }
  log("[smoke] OK — a real demo-harness session provisioned, spawned and completed.");

  return { ok: true, reason: "release gate passed: migrations applied, preflight clean, smoke green." };
}

// Run as a CLI only when invoked directly (not when imported by tests).
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("release-cli.ts") || invokedPath.endsWith("release-cli.js")) {
  runReleaseGates()
    .then((result) => {
      if (!result.ok) {
        console.error(`[release] FAILED (${result.failedGate}): ${result.reason}`);
        process.exit(1);
      }
      console.log(`[release] ${result.reason}`);
    })
    .catch((err: unknown) => {
      console.error("[release] error:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
