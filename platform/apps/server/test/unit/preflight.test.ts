import { describe, it, expect } from "vitest";
import {
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
    const report = preflight(
      input({ harness: "demo", env: { VERCEL_OIDC_TOKEN: "tok" } }),
      okDeps,
    );
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
    const report = preflight(
      input({ harness: "demo", env: { VERCEL_TOKEN: "t" } }),
      okDeps,
    );
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
    const report = preflight(
      input({ harness: "demo", env: { VERCEL_OIDC_TOKEN: "tok" } }),
      { binaryAvailable: () => true, moduleResolvable: () => false },
    );
    const check = report.checks.find((c) => c.name === "vercel-sdk");
    expect(check?.status).toBe("fail");
    expect(check?.message).toContain("@vercel/sandbox");
    expect(report.ok).toBe(false);
  });

  it("claude-code with the binary present + an API key passes", () => {
    const report = preflight(
      input({ runtime: "local", env: { ANTHROPIC_API_KEY: "sk" } }),
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

  it("claude-code with no API key but a Bedrock/Vertex chain selected passes (no key needed)", () => {
    const report = preflight(
      input({ runtime: "local", env: { CLAUDE_CODE_USE_BEDROCK: "1" } }),
      okDeps,
    );
    expect(report.checks.find((c) => c.name === "claude-auth")?.status).toBe("pass");
    expect(report.ok).toBe(true);
  });

  it("claude-code with neither a key nor a provider chain WARNS (interactive login is valid) but stays ok", () => {
    const report = preflight(input({ runtime: "local", env: {} }), okDeps);
    const check = report.checks.find((c) => c.name === "claude-auth");
    expect(check?.status).toBe("warn");
    expect(report.ok).toBe(true); // a warn does not block
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
    const report = preflight(input({ env: {} }), { binaryAvailable: () => false, moduleResolvable: () => false });
    expect(report.ok).toBe(false);
    const err = new PreflightError(report);
    expect(err).toBeInstanceOf(Error);
    expect(err.report).toBe(report);
    expect(err.message.toLowerCase()).toContain("preflight");
    // the summary names failed checks, never a secret value
    expect(err.message).not.toContain("SECRET");
  });
});
