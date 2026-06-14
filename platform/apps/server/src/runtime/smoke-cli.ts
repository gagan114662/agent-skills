/**
 * `node dist/runtime/smoke-cli.js` — the post-deploy preflight + demo-harness smoke (#166; #238).
 *
 * Wired as the Fly `[deploy] release_command`: it runs on a one-off machine booted from the NEW image
 * before traffic shifts, and a non-zero exit aborts the rollout — so an image that cannot spawn a
 * session never reaches production. No DB, no model spend. Two gates, in order:
 *   1. PREFLIGHT (#238): assert the live host posture — `bash`/`git` on PATH, the `claude` binary, AND
 *      the per-session workspace root is WRITABLE by the runtime user. This catches a missing tool / a
 *      root-owned workspace dir (the #238 prod cause: every session died at provision with exit n/a)
 *      with an actionable, secret-free message BEFORE we even spawn.
 *   2. SMOKE (#166): provision a per-session workspace + spawn ONE real demo-harness session end-to-end.
 */
import { runDemoSmoke } from "./smoke-demo.js";
import { defaultPreflight } from "./default.js";

async function main(): Promise<void> {
  // Gate 1 — preflight (#238): a missing tool / non-writable workspace root aborts the deploy here,
  // not in front of users. The report is content-free (names + statuses only), so it is safe to log.
  const report = defaultPreflight();
  for (const c of report.checks) console.log(`[preflight] ${c.status.toUpperCase()} ${c.name}: ${c.message}`);
  if (!report.ok) {
    const failed = report.checks.filter((c) => c.status === "fail");
    for (const c of failed) if (c.remedy) console.error(`[preflight] remedy (${c.name}): ${c.remedy}`);
    console.error(
      `[preflight] FAILED — ${failed.map((c) => c.name).join(", ")}. ` +
        `Aborting deploy: the agent image is missing a required tool or a writable workspace root (#238).`,
    );
    process.exit(1);
  }
  console.log("[preflight] OK — required tools present and the per-session workspace root is writable.");

  // Gate 2 — smoke (#166): provision + spawn a real demo session end-to-end.
  const res = await runDemoSmoke();
  // The demo harness emits only non-secret text (and masks DEMO_SECRET itself), so this is safe to log.
  console.log(`[smoke] ${res.reason}`);
  if (!res.ok) {
    console.error(
      `[smoke] FAILED — status=${res.status} exit=${res.exitCode} sawMarker=${res.sawMarker}. ` +
        `Aborting deploy: the image cannot run an agent session end-to-end.`,
    );
    process.exit(1);
  }
  console.log("[smoke] OK — a real demo-harness session provisioned, spawned and completed.");
}

main().catch((err: unknown) => {
  console.error("[smoke] error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
