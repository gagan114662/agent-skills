import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * #420 sandcastle runtime pilot — integration-shape gate.
 *
 * The pilot at `platform/pilots/sandcastle-runtime/` ports ipop's agent runtime onto mattpocock/sandcastle
 * (`@ai-hero/sandcastle`). It is build/typecheck/lint-isolated (outside the pnpm workspace), so nothing else
 * compiles it — this test is the contract that proves the port keeps ipop's runtime invariants. It reads the
 * pilot as TEXT (no `@ai-hero/sandcastle` import, so CI needs none of the pilot's uninstalled deps) and asserts
 * the things that must survive the port: idiomatic sandcastle usage, the `AgentRuntime` interface mapping, the
 * managed-model rule, per-tenant token discipline (#192 — never in source), and cancel/stream wiring.
 *
 * It also asserts the LIVE seam it claims parity with still has the shape the pilot mirrors, so a future change
 * to `runtime/types.ts` that breaks the mapping trips here.
 */
const pilotPath = (p: string) =>
  fileURLToPath(new URL(`../../../../pilots/sandcastle-runtime/${p}`, import.meta.url));
const pilot = (p: string) => readFileSync(pilotPath(p), "utf8");
const live = (p: string) => readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), "utf8");

const runtimeTs = pilot("runtime.ts");
const readme = pilot("README.md");
const liveTypes = live("runtime/types.ts");

describe("#420 sandcastle runtime pilot ⇄ ipop AgentRuntime parity", () => {
  it("codes the idiomatic sandcastle API (run + claudeCode + a sandbox provider)", () => {
    expect(runtimeTs).toMatch(/from "@ai-hero\/sandcastle"/);
    expect(runtimeTs).toMatch(/\brun\(\{/);
    expect(runtimeTs).toMatch(/claudeCode\(/);
    expect(runtimeTs).toMatch(/sandboxes\/vercel/);
    expect(runtimeTs).toMatch(/sandboxes\/docker/);
  });

  it("implements ipop's AgentRuntime seam (kind + start → RunningSession)", () => {
    expect(runtimeTs).toMatch(/implements AgentRuntime/);
    expect(runtimeTs).toMatch(/kind\s*=\s*"sandcastle"/);
    expect(runtimeTs).toMatch(/start\(job: AgentJob, hooks: RuntimeHooks\)/);
    // the RunningSession contract the SessionManager depends on
    for (const member of ["sessionId", "wait", "cancel"]) {
      expect(runtimeTs).toContain(member);
    }
    // the live seam still declares the same shape the pilot mirrors
    expect(liveTypes).toMatch(/interface AgentRuntime/);
    expect(liveTypes).toMatch(/start\(job: AgentJob, hooks: RuntimeHooks\): Promise<RunningSession>/);
    expect(liveTypes).toMatch(/cancel\(reason: TerminalReason\)/);
  });

  it("uses the managed fleet model — a user never picks a model", () => {
    expect(runtimeTs).toMatch(/claude-opus-4-8/);
    // the model is a constant handed to claudeCode, not a per-request input
    expect(runtimeTs).toMatch(/MANAGED_MODEL/);
  });

  it("injects the tenant's OWN token from job.secrets — never a hardcoded credential (#192)", () => {
    // the credential flows secrets → claudeCode({ env }), the highest-priority resolution
    expect(runtimeTs).toMatch(/job\.secrets\.CLAUDE_CODE_OAUTH_TOKEN/);
    expect(runtimeTs).toMatch(/claudeCode\([^)]*\{[\s\S]*env:/);
    // no literal token/key baked into the adapter
    expect(runtimeTs).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(runtimeTs).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN\s*=\s*["']\w/);
  });

  it("the #13 human gate stays OUTSIDE the harness (bypassPermissions, not an in-harness prompt)", () => {
    // ipop gates the irreversible action itself; an in-harness permission prompt would deadlock a
    // non-interactive run. The README must explain why, so the choice is not mistaken for a safety hole.
    expect(runtimeTs).toMatch(/permissionMode:\s*"bypassPermissions"/);
    expect(readme.toLowerCase()).toMatch(/#13|approval gate|human gate/);
  });

  it("wires cancel() → AbortController and stream → onOutput (reaper + #469 Stop + live feed)", () => {
    expect(runtimeTs).toMatch(/new AbortController\(\)/);
    expect(runtimeTs).toMatch(/signal:\s*controller\.signal/);
    expect(runtimeTs).toMatch(/controller\.abort\(\)/);
    expect(runtimeTs).toMatch(/onAgentStreamEvent/);
    expect(runtimeTs).toMatch(/hooks\.onOutput/);
  });

  it("wait() never rejects — a thrown run maps to failed (teardown parity with the bespoke runtime)", () => {
    // the rejection branch of the run() promise yields status:"failed" so the SessionManager teardown
    // (release admission slot, finalize, route to self-healing) is byte-for-byte the same.
    expect(runtimeTs).toMatch(/status:\s*"failed"/);
    expect(runtimeTs).toMatch(/exitCode:\s*null/);
  });

  it("is honestly fenced — isolated pilot, not wired to prod, with the open questions documented", () => {
    const pkg = JSON.parse(pilot("package.json")) as { description?: string };
    expect(pkg.description ?? "").toMatch(/NOT wired to production/i);
    // the highest-risk parity items must be written down, not buried
    expect(readme.toLowerCase()).toContain("stream fidelity");
    expect(readme.toLowerCase()).toContain("git ownership");
    expect(readme.toLowerCase()).toMatch(/docker-in-docker|docker-on-fly|firecracker/);
  });
});
