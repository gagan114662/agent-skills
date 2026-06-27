import { describe, it, expect } from "vitest";
import {
  googleConnectionOAuthRequiredForRelease,
  googleOAuthRequiredForRelease,
  preflight,
  PreflightError,
  type PreflightDeps,
  type PreflightInput,
} from "../../src/runtime/preflight.js";

/** Deps that satisfy every probe — overridden per test to simulate a missing binary/SDK. */
const okDeps: PreflightDeps = {
  binaryAvailable: () => true,
  moduleResolvable: () => true,
};

const input = (over: Partial<PreflightInput>): PreflightInput => ({
  profile: "prod",
  runtime: "sandbox",
  harness: "claude-code",
  env: {},
  ...over,
});

describe("preflight (#69 — validate posture before any run; never throws; secret-free)", () => {
  it("the default dev posture (local/demo) passes with no cloud creds, network, or SDK (bash present)", () => {
    const report = preflight(
      // bash is the one host binary the local runtime genuinely needs (it spawns the demo via bash);
      // every real dev host / CI image has it, so the default posture is still trivially green.
      input({ profile: "dev", runtime: "local", harness: "demo", env: {} }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => false },
    );
    expect(report.ok).toBe(true);
    expect(report.runtime).toBe("local");
    expect(report.harness).toBe("demo");
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("local runtime with bash MISSING fails — the #166 gap (sessions spawn 'bash -lc' and die at exec)", () => {
    const report = preflight(
      input({ profile: "dev", runtime: "local", harness: "demo", env: {} }),
      { binaryAvailable: () => false, moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "bash-binary");
    expect(check?.status).toBe("fail");
    expect(check?.message.toLowerCase()).toContain("bash");
    expect(check?.remedy).toContain("apk add");
    expect(report.ok).toBe(false);
  });

  it("the bash check is NOT applied to the sandbox runtime (bash is a microVM concern there, not the host)", () => {
    const report = preflight(
      input({ runtime: "sandbox", harness: "demo", env: { VERCEL_OIDC_TOKEN: "tok" } }),
      okDeps,
    );
    expect(report.checks.find((c) => c.name === "bash-binary")).toBeUndefined();
  });

  it("sandbox + OIDC token passes the Vercel auth check", () => {
    const report = preflight(input({ harness: "demo", env: { VERCEL_OIDC_TOKEN: "tok" } }), okDeps);
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "vercel-auth")?.status).toBe("pass");
  });

  it("sandbox + full access-token trio passes", () => {
    const report = preflight(
      input({
        harness: "demo",
        env: { VERCEL_TOKEN: "t", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "proj" },
      }),
      okDeps,
    );
    expect(report.checks.find((c) => c.name === "vercel-auth")?.status).toBe("pass");
  });

  it("sandbox + a PARTIAL access-token trio fails and names the missing vars", () => {
    const report = preflight(input({ harness: "demo", env: { VERCEL_TOKEN: "t" } }), okDeps);
    const check = report.checks.find((c) => c.name === "vercel-auth");
    expect(report.ok).toBe(false);
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("VERCEL_TEAM_ID");
    expect(check?.message).toContain("VERCEL_PROJECT_ID");
  });

  it("sandbox with no Vercel auth at all fails with an actionable remedy", () => {
    const report = preflight(input({ harness: "demo", env: {} }), okDeps);
    const check = report.checks.find((c) => c.name === "vercel-auth");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("VERCEL_OIDC_TOKEN");
    expect(check?.remedy).toBeTruthy();
  });

  it("sandbox with the SDK unresolvable fails with the install remedy", () => {
    const report = preflight(input({ harness: "demo", env: { VERCEL_OIDC_TOKEN: "tok" } }), {
      binaryAvailable: () => true,
      moduleResolvable: () => false,
    });
    const check = report.checks.find((c) => c.name === "vercel-sdk");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("@vercel/sandbox");
    expect(report.ok).toBe(false);
  });

  it("claude-code with the binary present + a deployment-wide subscription token passes (#246)", () => {
    const report = preflight(
      input({ runtime: "local", env: { CLAUDE_CODE_OAUTH_TOKEN: "oat" } }),
      okDeps,
    );
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === "claude-binary")?.status).toBe("pass");
    expect(report.checks.find((c) => c.name === "claude-auth")?.status).toBe("pass");
  });

  it("claude-code with a MISSING binary fails (and honors CLAUDE_BIN in the message)", () => {
    const report = preflight(
      input({ runtime: "local", env: { CLAUDE_BIN: "/opt/claude", ANTHROPIC_API_KEY: "sk" } }),
      { binaryAvailable: () => false, moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "claude-binary");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("/opt/claude");
    expect(report.ok).toBe(false);
  });

  it("#246 subscription-only: no deployment token WARNS (per-workspace auth) but stays ok", () => {
    // Auth is per-workspace (#246) — the host posture has no API key, so claude-auth is informational.
    const report = preflight(
      input({ runtime: "local", env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
      okDeps,
    );
    const check = report.checks.find((c) => c.name === "claude-auth");
    expect(check?.status).toBe("warn");
    expect(report.ok).toBe(true); // a warn does not block
  });

  it("claude-code with no deployment-wide token WARNS (per-workspace subscription is valid) but stays ok", () => {
    const report = preflight(input({ runtime: "local", env: {} }), okDeps);
    const check = report.checks.find((c) => c.name === "claude-auth");
    expect(check?.status).toBe("warn");
    expect(report.ok).toBe(true); // a warn does not block
  });

  it("claude-code asserts git is present (the harness + #51 worktree provisioner shell out to it) — #238", () => {
    const report = preflight(
      input({ runtime: "local", env: { ANTHROPIC_API_KEY: "sk" } }),
      // every binary present EXCEPT git → the deploy must fail on the missing tool.
      { binaryAvailable: (n) => n !== "git", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "git-binary");
    expect(check?.status).toBe("fail");
    expect(check?.message.toLowerCase()).toContain("git");
    expect(report.ok).toBe(false);
  });

  it("the demo harness does NOT require git (it never shells out to it) — #238", () => {
    const report = preflight(
      input({ profile: "dev", runtime: "local", harness: "demo", env: {} }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => false },
    );
    expect(report.checks.find((c) => c.name === "git-binary")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it("a NON-writable per-session workspace root FAILS the deploy — the prod EACCES that died at exit n/a (#238)", () => {
    const report = preflight(
      input({
        runtime: "local",
        harness: "demo",
        workspaceRoot: "/app/.reload/workspaces",
        env: {},
      }),
      {
        binaryAvailable: (n) => n === "bash",
        moduleResolvable: () => true,
        dirWritable: () => false,
      },
    );
    const check = report.checks.find((c) => c.name === "workspace-writable");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("/app/.reload/workspaces");
    expect(check?.remedy).toContain("RELOAD_WORKSPACE_ROOT");
    expect(report.ok).toBe(false);
  });

  it("a writable workspace root passes; the check is skipped when no root is resolved — #238", () => {
    const pass = preflight(
      input({
        runtime: "local",
        harness: "demo",
        workspaceRoot: "/home/reload/agent-workspaces",
        env: {},
      }),
      {
        binaryAvailable: (n) => n === "bash",
        moduleResolvable: () => true,
        dirWritable: () => true,
      },
    );
    expect(pass.checks.find((c) => c.name === "workspace-writable")?.status).toBe("pass");
    expect(pass.ok).toBe(true);

    const skipped = preflight(input({ runtime: "local", harness: "demo", env: {} }), {
      binaryAvailable: (n) => n === "bash",
      moduleResolvable: () => true,
      dirWritable: () => false,
    });
    expect(skipped.checks.find((c) => c.name === "workspace-writable")).toBeUndefined();
    expect(skipped.ok).toBe(true);
  });

  it("the workspace-writable check is NOT applied to the sandbox runtime (provisioning is a microVM concern) — #238", () => {
    const report = preflight(
      input({
        runtime: "sandbox",
        harness: "demo",
        workspaceRoot: "/app/.reload",
        env: { VERCEL_OIDC_TOKEN: "t" },
      }),
      { binaryAvailable: () => true, moduleResolvable: () => true, dirWritable: () => false },
    );
    expect(report.checks.find((c) => c.name === "workspace-writable")).toBeUndefined();
  });

  it("Google OAuth preflight is skipped when not required and completely absent, keeping local/dev green (#1262)", () => {
    const report = preflight(
      input({ profile: "dev", runtime: "local", harness: "demo", env: {} }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    expect(report.checks.find((c) => c.name === "google-oauth")).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it("Google OAuth preflight fails the release gate when admission requires it but config is absent (#1262)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {},
        googleOAuthRequired: true,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "google-oauth");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(check?.message).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(check?.message).toContain("GOOGLE_OAUTH_REDIRECT_URI");
    expect(check?.remedy).toContain("GOOGLE_OAUTH_CLIENT_ID");
    expect(report.ok).toBe(false);
  });

  it("requires Google OAuth by default for prod release gates (#1288)", () => {
    expect(googleOAuthRequiredForRelease("prod", {})).toBe(true);
    expect(googleOAuthRequiredForRelease("dev", {})).toBe(false);
    expect(googleOAuthRequiredForRelease("dev", { RELOAD_REQUIRE_GOOGLE_OAUTH: "true" })).toBe(
      true,
    );
    expect(googleOAuthRequiredForRelease("dev", { RELOAD_REQUIRE_GOOGLE_OAUTH: "1" })).toBe(true);
  });

  it("Google OAuth preflight warns on partial config even when the release gate is not required (#1262)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "SECRET_CLIENT_ID",
          GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
        },
        googleOAuthRequired: false,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "google-oauth");
    expect(check?.status).toBe("warn");
    expect(check?.message).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_ID");
    expect(JSON.stringify(report)).not.toContain("https://api.ipop.ai/auth/google/callback");
  });

  it("Google OAuth preflight passes when the full deployment trio is present (#1262)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "SECRET_CLIENT_VALUE",
          GOOGLE_OAUTH_CLIENT_SECRET: "SECRET_CLIENT_SECRET",
          GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
        },
        googleOAuthRequired: true,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    expect(report.checks.find((c) => c.name === "google-oauth")?.status).toBe("pass");
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_VALUE");
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_SECRET");
  });

  it("Google connection OAuth preflight passes prod when the callback derives from the Google API redirect (#1285)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "SECRET_CLIENT_VALUE",
          GOOGLE_OAUTH_CLIENT_SECRET: "SECRET_CLIENT_SECRET",
          GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
        },
        googleOAuthRequired: true,
        googleConnectionOAuthRequired: true,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "google-connection-oauth");
    expect(check?.status).toBe("pass");
    expect(report.ok).toBe(true);
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_VALUE");
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_SECRET");
    expect(JSON.stringify(report)).not.toContain("https://api.ipop.ai");
  });

  it("Google connection OAuth preflight still fails when no dedicated or derivable callback exists (#1285)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "SECRET_CLIENT_VALUE",
          GOOGLE_OAUTH_CLIENT_SECRET: "SECRET_CLIENT_SECRET",
        },
        googleOAuthRequired: false,
        googleConnectionOAuthRequired: true,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "google-connection-oauth");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("GOOGLE_CONNECTION_OAUTH_REDIRECT_URI");
    expect(check?.remedy).toContain("/me/connections/google/oauth/callback");
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_VALUE");
    expect(JSON.stringify(report)).not.toContain("SECRET_CLIENT_SECRET");
  });

  it("Google connection OAuth preflight passes when the connector callback is present (#1285)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {
          GOOGLE_OAUTH_CLIENT_ID: "SECRET_CLIENT_VALUE",
          GOOGLE_OAUTH_CLIENT_SECRET: "SECRET_CLIENT_SECRET",
          GOOGLE_OAUTH_REDIRECT_URI: "https://api.ipop.ai/auth/google/callback",
          GOOGLE_CONNECTION_OAUTH_REDIRECT_URI:
            "https://api.ipop.ai/me/connections/google/oauth/callback",
        },
        googleOAuthRequired: true,
        googleConnectionOAuthRequired: true,
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    expect(report.checks.find((c) => c.name === "google-connection-oauth")?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("requires Google connection OAuth by default for prod release gates (#1285)", () => {
    expect(googleConnectionOAuthRequiredForRelease("prod", {})).toBe(true);
    expect(googleConnectionOAuthRequiredForRelease("dev", {})).toBe(false);
    expect(
      googleConnectionOAuthRequiredForRelease("dev", {
        RELOAD_REQUIRE_GOOGLE_CONNECTION_OAUTH: "true",
      }),
    ).toBe(true);
  });

  it("Reach live-proof fails prod when autonomous outreach is enabled with mock prospects (#1286)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {},
        reachLiveProofRequired: true,
        reach: {
          enabled: true,
          prospectSource: "mock",
          sendProvider: "postmark",
          liveSendEnabled: true,
          brandName: "ipop",
          postalAddress: "1 Market St, San Francisco, CA",
          unsubscribeUrl: "https://ipop.ai/unsubscribe",
        },
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "reach-live-proof");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("prospectSource=mock");
    expect(report.ok).toBe(false);
  });

  it("Reach live-proof fails prod when every send channel is dry-run or queue-only (#1286)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {},
        reachLiveProofRequired: true,
        reach: { enabled: true, prospectSource: "imported", sendProvider: "dryrun" },
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "reach-live-proof");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("no live send channel configured");
    expect(report.ok).toBe(false);
  });

  it("Reach live-proof warns, rather than blocks, in dev when live proof is not required (#1286)", () => {
    const report = preflight(
      input({
        profile: "dev",
        runtime: "local",
        harness: "demo",
        env: {},
        reach: { enabled: true, prospectSource: "imported", sendProvider: "dryrun" },
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    const check = report.checks.find((c) => c.name === "reach-live-proof");
    expect(check?.status).toBe("warn");
    expect(report.ok).toBe(true);
  });

  it("Reach live-proof passes with imported prospects, live sender, and footer config (#1286)", () => {
    const report = preflight(
      input({
        profile: "prod",
        runtime: "local",
        harness: "demo",
        env: {},
        reachLiveProofRequired: true,
        reach: {
          enabled: true,
          prospectSource: "imported",
          sendProvider: "postmark",
          liveSendEnabled: true,
          brandName: "ipop",
          postalAddress: "1 Market St, San Francisco, CA",
          unsubscribeUrl: "https://ipop.ai/unsubscribe",
        },
      }),
      { binaryAvailable: (n) => n === "bash", moduleResolvable: () => true },
    );
    expect(report.checks.find((c) => c.name === "reach-live-proof")?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("never returns a secret VALUE — only variable names + statuses", () => {
    const report = preflight(
      input({
        env: {
          VERCEL_TOKEN: "SECRET_VERCEL_TOKEN_VALUE",
          VERCEL_TEAM_ID: "team",
          VERCEL_PROJECT_ID: "proj",
          ANTHROPIC_API_KEY: "SECRET_ANTHROPIC_KEY_VALUE",
        },
      }),
      okDeps,
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SECRET_VERCEL_TOKEN_VALUE");
    expect(serialized).not.toContain("SECRET_ANTHROPIC_KEY_VALUE");
  });

  it("PreflightError carries the report and a content-free summary of failed checks", () => {
    const report = preflight(input({ env: {} }), {
      binaryAvailable: () => false,
      moduleResolvable: () => false,
    });
    expect(report.ok).toBe(false);
    const err = new PreflightError(report);
    expect(err).toBeInstanceOf(Error);
    expect(err.report).toBe(report);
    expect(err.message.toLowerCase()).toContain("preflight");
    // the summary names failed checks, never a secret value
    expect(err.message).not.toContain("SECRET");
  });
});
