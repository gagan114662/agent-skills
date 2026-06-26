/**
 * Host-side preflight (#69): validate the configured cloud + real-agent posture BEFORE booting the
 * server or launching a session. Run it during setup —
 *
 *   pnpm -C platform --filter @reload/server preflight
 *
 * It resolves the profile from the env (`RELOAD_PROFILE`, default `dev`), runs the posture checks
 * against `process.env`, prints a ✓/⚠/✗ report, and exits non-zero when a check fails. It makes NO
 * cloud call and prints only variable names + statuses — never a secret value.
 */
import { loadEnv } from "../src/env.js";
import { googleOAuthRequiredForRelease, preflight, type CheckResult } from "../src/runtime/preflight.js";

const ICON: Record<CheckResult["status"], string> = { pass: "✓", warn: "⚠", fail: "✗" };

function main(): void {
  const env = loadEnv().agent;
  const report = preflight({
    profile: env.profile,
    runtime: env.runtime,
    harness: env.harness,
    env: process.env,
    googleOAuthRequired: googleOAuthRequiredForRelease(env.profile, process.env),
  });

  process.stdout.write(
    `\nPreflight — profile "${report.profile}" (runtime=${report.runtime}, harness=${report.harness})\n\n`,
  );
  for (const c of report.checks) {
    process.stdout.write(`  ${ICON[c.status]} ${c.name.padEnd(14)} ${c.message}\n`);
    if (c.remedy && c.status !== "pass") process.stdout.write(`      ↳ ${c.remedy}\n`);
  }
  process.stdout.write(
    report.ok
      ? `\nOK — the "${report.profile}" posture is ready.\n`
      : `\nNOT READY — fix the ✗ checks above, then re-run preflight.\n`,
  );
  process.exit(report.ok ? 0 : 1);
}

main();
