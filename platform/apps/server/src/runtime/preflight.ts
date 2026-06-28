import { accessSync, constants as fsConstants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ReachConfig } from "../config/schema.js";
import { resolveGoogleAdsConnectionRedirectUri } from "../connections/google-ads-oauth-config.js";
import { resolveGoogleConnectionRedirectUri } from "../connections/google-oauth-config.js";
import type { RuntimeKind } from "../db/repositories/agent-sessions.js";
import { resolveReachCaps } from "../reach/caps.js";
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
  /**
   * Whether a directory is creatable + writable (#238). Probes the EXACT operation the #58 workspace
   * provisioner does on every launch (`mkdir -p <root>/<id>` then write), so a non-writable workspace
   * root is caught at preflight/deploy instead of as a null-exit "spawn" failure on every session.
   * Optional so existing partial-deps tests keep compiling; the production probe is in {@link defaultDeps}.
   */
  dirWritable?: (path: string) => boolean;
}

export interface PreflightInput {
  profile: ProfileName;
  runtime: RuntimeKind;
  harness: HarnessKind;
  /** The process env to inspect for *presence* of credentials (values are never read out). */
  env: NodeJS.ProcessEnv;
  /** Whether the agent browser runtime (#174) is enabled — gates the Playwright/Chromium checks. */
  browserEnabled?: boolean;
  /**
   * The resolved (absolute) per-session workspace root the #58 provisioner will `mkdir` under (#238).
   * When provided on the local runtime, preflight asserts it is writable by the running (non-root) user
   * — the check that would have caught the prod EACCES where every session died at provision. Absent ⇒
   * the check is skipped (default posture / unit tests that don't exercise provisioning).
   */
  workspaceRoot?: string;
  /**
   * Whether public admission requires Google OAuth to be configured for this deployment (#1262).
   * When false, a completely absent Google config is skipped so local/demo posture stays green, but a
   * partial config still warns because it would route users into a broken auth start.
   */
  googleOAuthRequired?: boolean;
  /** Whether Google must also be connectable as a marketing-data connector (#1285). */
  googleConnectionOAuthRequired?: boolean;
  /** Whether X must be connectable as a social publishing connector (#1285). */
  xConnectionOAuthRequired?: boolean;
  /** Whether Google Ads must be connectable as a paid acquisition connector (#1285). */
  googleAdsConnectionOAuthRequired?: boolean;
  /** Whether Meta Ads must be connectable as a paid acquisition connector (#1285). */
  metaAdsConnectionOAuthRequired?: boolean;
  /** Whether LinkedIn must be connectable as a social publishing connector (#1285). */
  linkedInConnectionOAuthRequired?: boolean;
  /** Reach outbound policy for the deployment-level live-proof gate (#1286). */
  reach?: ReachConfig;
  /** Whether enabled Reach must prove it is not mock/dry-run before a release can pass (#1286). */
  reachLiveProofRequired?: boolean;
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

export function googleOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    profile === "prod" ||
    env.RELOAD_REQUIRE_GOOGLE_OAUTH === "1" ||
    env.RELOAD_REQUIRE_GOOGLE_OAUTH === "true"
  );
}

export function googleConnectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    profile === "prod" ||
    env.RELOAD_REQUIRE_GOOGLE_CONNECTION_OAUTH === "1" ||
    env.RELOAD_REQUIRE_GOOGLE_CONNECTION_OAUTH === "true"
  );
}

function connectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
  envFlag: string,
): boolean {
  return profile === "prod" || env[envFlag] === "1" || env[envFlag] === "true";
}

export function xConnectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return connectionOAuthRequiredForRelease(profile, env, "RELOAD_REQUIRE_X_CONNECTION_OAUTH");
}

export function googleAdsConnectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return connectionOAuthRequiredForRelease(profile, env, "RELOAD_REQUIRE_GOOGLE_ADS_CONNECTION_OAUTH");
}

export function metaAdsConnectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return connectionOAuthRequiredForRelease(profile, env, "RELOAD_REQUIRE_META_ADS_CONNECTION_OAUTH");
}

export function linkedInConnectionOAuthRequiredForRelease(
  profile: ProfileName,
  env: NodeJS.ProcessEnv,
): boolean {
  return connectionOAuthRequiredForRelease(profile, env, "RELOAD_REQUIRE_LINKEDIN_CONNECTION_OAUTH");
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
      message:
        "Vercel access-token auth present (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID)",
    };
  }
  const missing = Object.entries(trio)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const remedy =
    "Authenticate with VERCEL_OIDC_TOKEN (run `vercel link && vercel env pull`), " +
    "or set all of VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID.";
  if (present === 0) {
    return {
      name,
      status: "fail",
      message: "no Vercel auth — set VERCEL_OIDC_TOKEN, or the access-token trio",
      remedy,
    };
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

/**
 * `bash` is the spawn target for EVERY local-runtime harness — the `demo` script runs as
 * `bash scripts/agent-harness-demo.sh` and the real harnesses as `bash -lc …` (see `harness.ts`). A
 * host that lacks it (a stock Alpine image ships only `ash`) fails every session at exec with no exit
 * code → "session failed exit n/a" (#166). The existing checks cover `claude` but not the shell that
 * launches it, so this is the gap that let a bash-less image ship.
 */
function checkBashBinary(deps: PreflightDeps): CheckResult {
  const name = "bash-binary";
  if (deps.binaryAvailable("bash")) {
    return { name, status: "pass", message: "bash shell found (the local-runtime spawn target)" };
  }
  return {
    name,
    status: "fail",
    message:
      "bash not found — every local-runtime session spawns 'bash' and dies at exec without it",
    remedy: "Install bash in the image (Alpine ships only 'ash'): apk add --no-cache bash.",
  };
}

/**
 * `git` is a tool the REAL coding harnesses shell out to (#238): `claude-code`/`codex` run `git` for
 * repo status/diff, and the #51 GitWorkspaceProvisioner needs it to create each session's worktree. A
 * debian-slim image ships NO git, so a real session fails — the exact "my runtime is missing a tool"
 * class the issue flags. Gate the deploy on it for the real harnesses (the `demo` harness never uses git).
 */
function checkGitBinary(deps: PreflightDeps): CheckResult {
  const name = "git-binary";
  if (deps.binaryAvailable("git")) {
    return {
      name,
      status: "pass",
      message: "git found (the coding harness + worktree provisioner shell out to it)",
    };
  }
  return {
    name,
    status: "fail",
    message:
      "git not found — the claude-code/codex harness and the #51 worktree provisioner require it",
    remedy: "Install git in the image (debian-slim ships none): apt-get install -y git.",
  };
}

/**
 * The per-session workspace root must be CREATABLE + WRITABLE by the running (non-root) user (#238).
 * The #58 provisioner does `mkdirSync('<workspaceRoot>/<sessionId>')` on every launch BEFORE the harness
 * spawns; when the root lives under a root-owned dir (e.g. `/app` in the image) the non-root user hits
 * EACCES, the error is caught, and the session surfaces as `exitCode=null` → the `spawn` class → the
 * misleading "missing a tool" copy. This probe reproduces that mkdir+write so a non-writable root fails
 * the deploy instead of every user's session. Secret-free: it emits the path only, never any value.
 */
function checkWorkspaceWritable(workspaceRoot: string, deps: PreflightDeps): CheckResult {
  const name = "workspace-writable";
  const probe = deps.dirWritable ?? defaultDeps.dirWritable;
  if (probe?.(workspaceRoot)) {
    return {
      name,
      status: "pass",
      message: `per-session workspace root is writable (${workspaceRoot})`,
    };
  }
  return {
    name,
    status: "fail",
    message: `per-session workspace root is not writable by this user (${workspaceRoot})`,
    remedy:
      "Point RELOAD_WORKSPACE_ROOT at a dir the runtime user owns (e.g. under $HOME), and create + chown " +
      "it in the image — a root-owned root makes every session die at provision with exit n/a.",
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
 * Claude auth presence (#246: subscription-only). Agent runs authenticate with the workspace's
 * connected `CLAUDE_CODE_OAUTH_TOKEN` (the per-tenant `claude setup-token` vault), injected per session
 * — NOT a host-level API key. So this host-posture check is informational only: it never fails (the real
 * auth is per-workspace, validated at @mention time by the subscription-first gate) and it surfaces a
 * deployment-wide subscription token if the operator set one (an org-wide default for shared workspaces).
 */
function checkClaudeAuth(env: NodeJS.ProcessEnv): CheckResult {
  const name = "claude-auth";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) {
    return {
      name,
      status: "pass",
      message: "deployment-wide Claude subscription token present (CLAUDE_CODE_OAUTH_TOKEN)",
    };
  }
  return {
    name,
    status: "warn",
    message:
      "no deployment-wide Claude token — agents authenticate with each workspace's connected subscription " +
      "(Settings → Connect Claude); a workspace that hasn't connected gets a reconnect prompt, never an API key",
    remedy:
      "Each workspace owner connects their own `claude setup-token` in Settings → Connect Claude.",
  };
}

/** The `codex` binary (or `CODEX_BIN`) must be runnable for the Codex subscription harness. */
function checkCodexBinary(env: NodeJS.ProcessEnv, deps: PreflightDeps): CheckResult {
  const name = "codex-binary";
  const bin = env.CODEX_BIN || "codex";
  if (deps.binaryAvailable(bin)) {
    return { name, status: "pass", message: `Codex CLI binary found (${bin})` };
  }
  return {
    name,
    status: "fail",
    message: `Codex CLI binary not found (looked for '${bin}')`,
    remedy: "Install Codex CLI in the image, or set CODEX_BIN to its absolute path.",
  };
}

/**
 * Codex production auth is subscription-backed, not API-key-backed. The deployment injects the
 * owner's `~/.codex/auth.json` as `CODEX_AUTH_JSON`; the harness writes it to `$CODEX_HOME/auth.json`
 * just before spawning `codex exec`. Secret-free: this check observes presence only.
 */
function checkCodexAuth(env: NodeJS.ProcessEnv): CheckResult {
  const name = "codex-auth";
  if (env.CODEX_AUTH_JSON) {
    return { name, status: "pass", message: "Codex subscription auth present (CODEX_AUTH_JSON)" };
  }
  return {
    name,
    status: "fail",
    message: "Codex subscription auth missing (CODEX_AUTH_JSON)",
    remedy:
      "Export the owner's Codex subscription login as CODEX_AUTH_JSON from ~/.codex/auth.json; do not use an OpenAI API key for ipop agents.",
  };
}

/** Google OAuth powers the public Get Started gate (#1262). Names only, never values. */
function checkGoogleOAuth(env: NodeJS.ProcessEnv, required: boolean): CheckResult | undefined {
  const name = "google-oauth";
  const vars = {
    GOOGLE_OAUTH_CLIENT_ID: Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: Boolean(env.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_OAUTH_REDIRECT_URI: Boolean(env.GOOGLE_OAUTH_REDIRECT_URI),
  } as const;
  const entries = Object.entries(vars);
  const present = entries.filter(([, v]) => v).length;
  if (present === entries.length) {
    return {
      name,
      status: "pass",
      message:
        "Google OAuth config present (GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REDIRECT_URI)",
    };
  }
  if (!required && present === 0) return undefined;

  const missing = entries.filter(([, v]) => !v).map(([k]) => k);
  return {
    name,
    status: required ? "fail" : "warn",
    message: `Google OAuth config incomplete — missing: ${missing.join(", ")}`,
    remedy:
      "Create a Google OAuth web client for the deployed origin and set the full trio: " +
      "GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_OAUTH_REDIRECT_URI.",
  };
}

/** Google connector OAuth powers Search Console + Analytics work after sign-in (#1285). */
function checkGoogleConnectionOAuth(
  env: NodeJS.ProcessEnv,
  required: boolean,
): CheckResult | undefined {
  const name = "google-connection-oauth";
  const vars = {
    GOOGLE_OAUTH_CLIENT_ID: Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
    GOOGLE_OAUTH_CLIENT_SECRET: Boolean(env.GOOGLE_OAUTH_CLIENT_SECRET),
    GOOGLE_CONNECTION_OAUTH_REDIRECT_URI: Boolean(resolveGoogleConnectionRedirectUri(env)),
  } as const;
  const entries = Object.entries(vars);
  const present = entries.filter(([, v]) => v).length;
  if (present === entries.length) {
    return {
      name,
      status: "pass",
      message:
        "Google connection OAuth config present (GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET + GOOGLE_CONNECTION_OAUTH_REDIRECT_URI)",
    };
  }
  if (!required && present === 0) return undefined;

  const missing = entries.filter(([, v]) => !v).map(([k]) => k);
  return {
    name,
    status: required ? "fail" : "warn",
    message: "Google connection OAuth config incomplete — missing: " + missing.join(", "),
    remedy:
      "Set GOOGLE_CONNECTION_OAUTH_REDIRECT_URI to https://<api-host>/me/connections/google/oauth/callback, or set GOOGLE_OAUTH_REDIRECT_URI on the same API origin so the connection callback can be derived. Add the exact callback URI to the Google OAuth web client.",
  };
}

function connectionOAuthCheck(input: {
  name: string;
  label: string;
  vars: Record<string, boolean>;
  required: boolean;
  remedy: string;
}): CheckResult | undefined {
  const entries = Object.entries(input.vars);
  const present = entries.filter(([, v]) => v).length;
  if (present === entries.length) {
    return {
      name: input.name,
      status: "pass",
      message: `${input.label} config present (${entries.map(([key]) => key).join(" + ")})`,
    };
  }
  if (!input.required && present === 0) return undefined;

  const missing = entries.filter(([, v]) => !v).map(([key]) => key);
  return {
    name: input.name,
    status: input.required ? "fail" : "warn",
    message: `${input.label} config incomplete — missing: ${missing.join(", ")}`,
    remedy: input.remedy,
  };
}

function checkXConnectionOAuth(env: NodeJS.ProcessEnv, required: boolean): CheckResult | undefined {
  return connectionOAuthCheck({
    name: "x-connection-oauth",
    label: "X connection OAuth",
    vars: {
      X_OAUTH_CLIENT_ID: Boolean(env.X_OAUTH_CLIENT_ID),
      X_OAUTH_CLIENT_SECRET: Boolean(env.X_OAUTH_CLIENT_SECRET),
      X_CONNECTION_OAUTH_REDIRECT_URI: Boolean(env.X_CONNECTION_OAUTH_REDIRECT_URI),
    },
    required,
    remedy:
      "Set X_OAUTH_CLIENT_ID, X_OAUTH_CLIENT_SECRET, and X_CONNECTION_OAUTH_REDIRECT_URI to https://<api-host>/me/connections/x/oauth/callback, then add that exact callback URI to the X app.",
  });
}

function checkGoogleAdsConnectionOAuth(
  env: NodeJS.ProcessEnv,
  required: boolean,
): CheckResult | undefined {
  return connectionOAuthCheck({
    name: "google-ads-connection-oauth",
    label: "Google Ads connection OAuth",
    vars: {
      GOOGLE_OAUTH_CLIENT_ID: Boolean(env.GOOGLE_OAUTH_CLIENT_ID),
      GOOGLE_OAUTH_CLIENT_SECRET: Boolean(env.GOOGLE_OAUTH_CLIENT_SECRET),
      GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI: Boolean(resolveGoogleAdsConnectionRedirectUri(env)),
    },
    required,
    remedy:
      "Set GOOGLE_ADS_CONNECTION_OAUTH_REDIRECT_URI to https://<api-host>/me/connections/google_ads/oauth/callback, or set GOOGLE_OAUTH_REDIRECT_URI on the same API origin so the Google Ads callback can be derived. Add the exact callback URI to the Google OAuth web client.",
  });
}

function checkMetaAdsConnectionOAuth(
  env: NodeJS.ProcessEnv,
  required: boolean,
): CheckResult | undefined {
  return connectionOAuthCheck({
    name: "meta-ads-connection-oauth",
    label: "Meta Ads connection OAuth",
    vars: {
      META_OAUTH_CLIENT_ID: Boolean(env.META_OAUTH_CLIENT_ID),
      META_OAUTH_CLIENT_SECRET: Boolean(env.META_OAUTH_CLIENT_SECRET),
      META_ADS_CONNECTION_OAUTH_REDIRECT_URI: Boolean(env.META_ADS_CONNECTION_OAUTH_REDIRECT_URI),
    },
    required,
    remedy:
      "Set META_OAUTH_CLIENT_ID, META_OAUTH_CLIENT_SECRET, and META_ADS_CONNECTION_OAUTH_REDIRECT_URI to https://<api-host>/me/connections/meta_ads/oauth/callback, then add that exact callback URI to the Meta app.",
  });
}

function checkLinkedInConnectionOAuth(
  env: NodeJS.ProcessEnv,
  required: boolean,
): CheckResult | undefined {
  return connectionOAuthCheck({
    name: "linkedin-connection-oauth",
    label: "LinkedIn connection OAuth",
    vars: {
      LINKEDIN_OAUTH_CLIENT_ID: Boolean(env.LINKEDIN_OAUTH_CLIENT_ID),
      LINKEDIN_OAUTH_CLIENT_SECRET: Boolean(env.LINKEDIN_OAUTH_CLIENT_SECRET),
      LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI: Boolean(env.LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI),
    },
    required,
    remedy:
      "Set LINKEDIN_OAUTH_CLIENT_ID, LINKEDIN_OAUTH_CLIENT_SECRET, and LINKEDIN_CONNECTION_OAUTH_REDIRECT_URI to https://<api-host>/me/connections/linkedin/oauth/callback, then add that exact callback URI to the LinkedIn app.",
  });
}

/**
 * Reach can be demo-safe with imported/mock prospects + recorded-only senders, but production must not
 * present that as autonomous customer acquisition. This check is intentionally secret-free: it reads only
 * resolved config names/booleans, never vault contents or provider tokens.
 */
function checkReachLiveProof(
  cfg: ReachConfig | undefined,
  required: boolean,
): CheckResult | undefined {
  const caps = resolveReachCaps(cfg);
  if (!caps.enabled) return undefined;

  const problems: string[] = [];
  if (caps.prospectSource === "mock") {
    problems.push("prospectSource=mock");
  }

  const emailLive = caps.sendProvider !== "dryrun" && caps.liveSendEnabled;
  const linkedinLive = caps.linkedinSendProvider !== "none" && caps.linkedinLiveSendEnabled;
  if (!emailLive && !linkedinLive) {
    problems.push("no live send channel configured");
  }
  if (caps.sendProvider === "dryrun" && caps.liveSendEnabled) {
    problems.push("liveSendEnabled=true but sendProvider=dryrun");
  }
  if (caps.sendProvider !== "dryrun" && !caps.liveSendEnabled) {
    problems.push(`${caps.sendProvider} configured but liveSendEnabled=false`);
  }
  if (emailLive && (!caps.brandName || !caps.postalAddress || !caps.unsubscribeUrl)) {
    problems.push("missing CAN-SPAM footer config");
  }

  if (problems.length === 0) {
    return {
      name: "reach-live-proof",
      status: "pass",
      message:
        `Reach live-proof config present (source=${caps.prospectSource}; ` +
        `email=${emailLive ? caps.sendProvider : "not-live"}; ` +
        `linkedin=${linkedinLive ? caps.linkedinSendProvider : "not-live"})`,
    };
  }

  return {
    name: "reach-live-proof",
    status: required ? "fail" : "warn",
    message: `Reach is enabled but still demo/recorded-only: ${problems.join(", ")}`,
    remedy:
      "Use imported or paid live prospects, configure a real permitted send channel, set CAN-SPAM footer fields, " +
      "and keep the UI labelled demo/dry-run until this check passes.",
  };
}

/**
 * The agent browser runtime (#174) needs the `playwright` package installed in the runtime image. A
 * missing package is a hard FAIL when the browser is enabled — we never ship an image whose browser
 * can't spawn (the #166 lesson). Mirrors {@link checkVercelSdk}.
 */
function checkPlaywrightModule(deps: PreflightDeps): CheckResult {
  const name = "browser-playwright";
  if (deps.moduleResolvable("playwright")) {
    return { name, status: "pass", message: "the 'playwright' package is installed" };
  }
  return {
    name,
    status: "fail",
    message: "the agent browser is enabled but 'playwright' is not installed",
    remedy:
      "Install it in the runtime image: pnpm --filter @reload/server add playwright && npx playwright install --with-deps chromium",
  };
}

/**
 * The Chromium binary check. Playwright manages its OWN Chromium under its cache (not on PATH), so an
 * explicit `BROWSER_BIN` (or a `chromium` on PATH) is a clear PASS, and its absence is a WARN — the
 * authoritative "can it actually spawn?" gate is the post-deploy smoke (`agent:browser-smoke`), which
 * launches a real page through the harness path.
 */
function checkBrowserBinary(env: NodeJS.ProcessEnv, deps: PreflightDeps): CheckResult {
  const name = "browser-binary";
  const bin = env.BROWSER_BIN || "chromium";
  if (deps.binaryAvailable(bin)) {
    return { name, status: "pass", message: `Chromium binary found (${bin})` };
  }
  return {
    name,
    status: "warn",
    message: `no '${bin}' on PATH — Playwright manages its own Chromium (verified by the smoke)`,
    remedy:
      "Run `npx playwright install --with-deps chromium`, or set BROWSER_BIN to an absolute path.",
  };
}

/**
 * Run the configured posture's preflight checks. Pure, total, secret-free. `ok` is true unless a
 * check *fails* (a `warn` is informational). The default `local`/`demo` posture has no external
 * checks and is trivially `ok`.
 */
export function preflight(
  input: PreflightInput,
  deps: PreflightDeps = defaultDeps,
): PreflightReport {
  const checks: CheckResult[] = [];

  if (input.runtime === "sandbox") {
    checks.push(checkVercelAuth(input.env));
    checks.push(checkVercelSdk(deps));
  } else {
    checks.push({
      name: "runtime",
      status: "pass",
      message: "runtime 'local' needs no cloud credentials",
    });
    // The local runtime spawns every harness via `bash` (the demo script / `bash -lc …`), so a host
    // without it fails EVERY session at exec → "exit n/a" (#166). Gate on it for the local runtime.
    checks.push(checkBashBinary(deps));
    // #238: every local session provisions a per-session dir under the workspace root BEFORE spawning.
    // A non-writable root (root-owned `/app` for the non-root runtime user) made that mkdir throw →
    // exit n/a → "spawn" on EVERY session. Assert it when the caller resolved the root (prod thunk does).
    if (input.workspaceRoot) checks.push(checkWorkspaceWritable(input.workspaceRoot, deps));
  }

  if (input.harness === "claude-code") {
    checks.push(checkClaudeBinary(input.env, deps));
    checks.push(checkClaudeAuth(input.env));
  } else if (input.harness === "codex") {
    checks.push(checkCodexBinary(input.env, deps));
    checks.push(checkCodexAuth(input.env));
  } else {
    checks.push({
      name: "harness",
      status: "pass",
      message: "harness 'demo' needs no model credentials",
    });
  }

  // #238: the real coding harnesses (claude-code/codex) shell out to `git`; the demo harness does not.
  if (input.harness === "claude-code" || input.harness === "codex")
    checks.push(checkGitBinary(deps));

  // #174 agent browser runtime: only checked when enabled (default OFF → no checks, posture unchanged).
  if (input.browserEnabled) {
    checks.push(checkPlaywrightModule(deps));
    checks.push(checkBrowserBinary(input.env, deps));
  }

  const googleOAuth = checkGoogleOAuth(input.env, Boolean(input.googleOAuthRequired));
  if (googleOAuth) checks.push(googleOAuth);
  const googleConnectionOAuth = checkGoogleConnectionOAuth(
    input.env,
    Boolean(input.googleConnectionOAuthRequired),
  );
  if (googleConnectionOAuth) checks.push(googleConnectionOAuth);
  const xConnectionOAuth = checkXConnectionOAuth(input.env, Boolean(input.xConnectionOAuthRequired));
  if (xConnectionOAuth) checks.push(xConnectionOAuth);
  const googleAdsConnectionOAuth = checkGoogleAdsConnectionOAuth(
    input.env,
    Boolean(input.googleAdsConnectionOAuthRequired),
  );
  if (googleAdsConnectionOAuth) checks.push(googleAdsConnectionOAuth);
  const metaAdsConnectionOAuth = checkMetaAdsConnectionOAuth(
    input.env,
    Boolean(input.metaAdsConnectionOAuthRequired),
  );
  if (metaAdsConnectionOAuth) checks.push(metaAdsConnectionOAuth);
  const linkedInConnectionOAuth = checkLinkedInConnectionOAuth(
    input.env,
    Boolean(input.linkedInConnectionOAuthRequired),
  );
  if (linkedInConnectionOAuth) checks.push(linkedInConnectionOAuth);

  const reachLiveProof = checkReachLiveProof(input.reach, Boolean(input.reachLiveProofRequired));
  if (reachLiveProof) checks.push(reachLiveProof);

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

/**
 * Whether a directory is creatable + writable — the EXACT op the #58 provisioner runs per launch (#238):
 * `mkdir -p` the root, then write (and clean up) a probe file. Total: any error (EACCES, read-only fs)
 * returns false instead of throwing, so preflight stays total.
 */
function realDirWritable(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true });
    const probe = join(path, `.preflight-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The production probes; tests inject fakes so they never touch disk or the module resolver. */
export const defaultDeps: PreflightDeps = {
  binaryAvailable: realBinaryAvailable,
  moduleResolvable: realModuleResolvable,
  dirWritable: realDirWritable,
};
