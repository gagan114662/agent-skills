import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeKind } from "../db/repositories/agent-sessions.js";
import type { HarnessKind } from "./harness.js";
import type { ProfileName } from "./posture.js";

/**
 * Preflight / doctor (#69, ADR-0038).
 *
 * Validates that the deployment's execution environment can actually run the configured posture
 * BEFORE any session launches — so a misconfigured `prod` profile (bad `VERCEL_*`, a missing
 * `claude` binary, the SDK not installed) fails fast with an actionable, secret-free message
 * instead of half-breaking deep inside a sandbox run, or worse, after a partial cloud call.
 *
 * Design guarantees:
 *   - **Pure + total.** `preflight()` never throws and makes no network/cloud call; it inspects only
 *     configuration *presence* and (via injectable probes) local availability.
 *   - **Secret-free.** Checks read only `Boolean(env.VAR)` and emit the variable **name** — never a
 *     value. The whole report, and {@link PreflightError.message}, are content-free.
 *   - **Default posture always passes.** `local` + `demo` need no credentials, binaries, or network,
 *     so the report is trivially `ok` — CI and a fresh clone are never gated.
 *   - **Injectable.** `binaryAvailable` / `moduleResolvable` are deps so unit tests need no real
 *     binary, package, or filesystem; the production path uses the real probes below.
 */
export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  /** Stable identifier, e.g. `vercel-auth` — never carries a value. */
  name: string;
  status: CheckStatus;
  /** Human-readable, actionable, secret-free. */
  message: string;
  /** Optional "how to fix" hint (also secret-free). */
  remedy?: string;
}

export interface PreflightReport {
  profile: ProfileName;
  runtime: RuntimeKind;
  harness: HarnessKind;
  /** True when no check failed (a `warn` does not block). */
  ok: boolean;
  checks: CheckResult[];
}

/** Injectable local-availability probes — defaulted to the real implementations below. */
export interface PreflightDeps {
  /** Whether an executable named (or pathed) `name` is runnable on this host. */
  binaryAvailable: (name: string) => boolean;
  /** Whether a module specifier resolves (e.g. `@vercel/sandbox` is installed). */
  moduleResolvable: (specifier: string) => boolean;
}

export interface PreflightInput {
  profile: ProfileName;
  runtime: RuntimeKind;
  harness: HarnessKind;
  /** The process env to inspect for *presence* of credentials (values are never read out). */
  env: NodeJS.ProcessEnv;
}

/** Thrown by the launch gate when preflight fails. Carries the report; the message is content-free. */
export class PreflightError extends Error {
  constructor(readonly report: PreflightReport) {
    super(PreflightError.summarize(report));
    this.name = "PreflightError";
  }

  private static summarize(report: PreflightReport): string {
    const failed = report.checks.filter((c) => c.status === "fail").map((c) => c.name);
    return (
      `preflight failed for profile "${report.profile}" ` +
      `(runtime=${report.runtime}, harness=${report.harness}): ${failed.join(", ")}. ` +
      `Run "reload doctor" (or "pnpm -C platform --filter @reload/server preflight") for details.`
    );
  }
}

/** Vercel auth: either an OIDC token, or the full access-token trio. Names only, never values. */
function checkVercelAuth(env: NodeJS.ProcessEnv): CheckResult {
  const name = "vercel-auth";
  const hasOidc = Boolean(env.VERCEL_OIDC_TOKEN);
  if (hasOidc) {
    return { name, status: "pass", message: "Vercel OIDC token present (VERCEL_OIDC_TOKEN)" };
  }
  const trio = {
    VERCEL_TOKEN: Boolean(env.VERCEL_TOKEN),
    VERCEL_TEAM_ID: Boolean(env.VERCEL_TEAM_ID),
    VERCEL_PROJECT_ID: Boolean(env.VERCEL_PROJECT_ID),
  } as const;
  const present = Object.entries(trio).filter(([, v]) => v).length;
  if (present === 3) {
    return {
      name,
      status: "pass",
      message: "Vercel access-token auth present (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID)",
    };
  }
  const missing = Object.entries(trio)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const remedy =
    "Authenticate with VERCEL_OIDC_TOKEN (run `vercel link && vercel env pull`), " +
    "or set all of VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.";
  if (present === 0) {
    return { name, status: "fail", message: "no Vercel auth — set VERCEL_OIDC_TOKEN, or the access-token trio", remedy };
  }
  return {
    name,
    status: "fail",
    message: `incomplete Vercel access-token auth — missing: ${missing.join(", ")}`,
    remedy,
  };
}

/** The Vercel sandbox SDK must be installed for the `sandbox` runtime to create microVMs. */
function checkVercelSdk(deps: PreflightDeps): CheckResult {
  const name = "vercel-sdk";
  if (deps.moduleResolvable("@vercel/sandbox")) {
    return { name, status: "pass", message: "@vercel/sandbox SDK is installed" };
  }
  return {
    name,
    status: "fail",
    message: "the '@vercel/sandbox' SDK is not installed",
    remedy: "Install it: pnpm --filter @reload/server add @vercel/sandbox",
  };
}

/** The `claude` binary (or `CLAUDE_BIN`) must be runnable for the `claude-code` harness. */
function checkClaudeBinary(env: NodeJS.ProcessEnv, deps: PreflightDeps): CheckResult {
  const name = "claude-binary";
  const bin = env.CLAUDE_BIN || "claude";
  if (deps.binaryAvailable(bin)) {
    return { name, status: "pass", message: `Claude Code binary found (${bin})` };
  }
  return {
    name,
    status: "fail",
    message: `Claude Code binary not found (looked for '${bin}')`,
    remedy: "Install Claude Code, or set CLAUDE_BIN to its absolute path.",
  };
}

/**
 * Claude auth presence. An API key OR a cloud-provider credential chain (Bedrock/Vertex) is a clear
 * pass. Otherwise WARN, not fail: an interactive `claude login` session on the host is also valid,
 * and we can't confirm it without spending — so we surface it as actionable advice, not a hard block.
 */
function checkClaudeAuth(env: NodeJS.ProcessEnv): CheckResult {
  const name = "claude-auth";
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) {
    return {
      name,
      status: "pass",
      message: "using a cloud provider credential chain (Bedrock/Vertex) — no API key needed",
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { name, status: "pass", message: "Anthropic API key present (ANTHROPIC_API_KEY)" };
  }
  return {
    name,
    status: "warn",
    message: "no ANTHROPIC_API_KEY detected — Claude Code will use an existing interactive login if present",
    remedy: "Run `claude login` on the host, set ANTHROPIC_API_KEY, or select Bedrock/Vertex.",
  };
}

/**
 * Run the configured posture's preflight checks. Pure, total, secret-free. `ok` is true unless a
 * check *fails* (a `warn` is informational). The default `local`/`demo` posture has no external
 * checks and is trivially `ok`.
 */
export function preflight(input: PreflightInput, deps: PreflightDeps = defaultDeps): PreflightReport {
  const checks: CheckResult[] = [];

  if (input.runtime === "sandbox") {
    checks.push(checkVercelAuth(input.env));
    checks.push(checkVercelSdk(deps));
  } else {
    checks.push({ name: "runtime", status: "pass", message: "runtime 'local' needs no cloud credentials" });
  }

  if (input.harness === "claude-code") {
    checks.push(checkClaudeBinary(input.env, deps));
    checks.push(checkClaudeAuth(input.env));
  } else {
    checks.push({ name: "harness", status: "pass", message: "harness 'demo' needs no model credentials" });
  }

  const ok = checks.every((c) => c.status !== "fail");
  return { profile: input.profile, runtime: input.runtime, harness: input.harness, ok, checks };
}

// --- real probes (used off the test path) -----------------------------------

/** Resolve a module specifier without importing it; false if it isn't installed. */
function realModuleResolvable(specifier: string): boolean {
  try {
    // import.meta.resolve is synchronous + side-effect-free in Node 22+, so the SDK stays optional.
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/** Whether an executable is runnable: an explicit path is checked directly, else PATH is scanned. */
function realBinaryAvailable(name: string): boolean {
  if (name.includes("/")) return isExecutable(name);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return dirs.some((dir) => isExecutable(join(dir, name)));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The production probes; tests inject fakes so they never touch disk or the module resolver. */
export const defaultDeps: PreflightDeps = {
  binaryAvailable: realBinaryAvailable,
  moduleResolvable: realModuleResolvable,
};
