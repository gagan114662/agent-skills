import { describe, it, expect } from "vitest";
import { evaluateHouseRubric, type RubricInput } from "../../src/build-loop/rubric.js";
import { DEFAULT_PROTECTED_PATHS } from "../../src/build-loop/guardrails.js";
import {
  issueNumberOf,
  renderVerdictComment,
  renderFindings,
  renderEscalationSummary,
  renderRevisionTask,
} from "../../src/build-loop/render.js";
import type { BuildRunRecord } from "../../src/build-loop/types.js";

function input(over: Partial<RubricInput> = {}): RubricInput {
  return {
    issueNumber: 172,
    files: ["apps/server/src/build-loop/engine.ts", "apps/server/test/unit/build-loop.test.ts"],
    addedLines: ["export function f() {}"],
    protectedPaths: DEFAULT_PROTECTED_PATHS,
    ...over,
  };
}

function run(over: Partial<BuildRunRecord> = {}): BuildRunRecord {
  return {
    id: "run-1",
    workspaceId: "w-1",
    issueRef: "github:acme/web#172",
    issueTitle: "Self-shipping loop",
    priority: 0,
    dependsOn: null,
    agentOk: true,
    status: "reviewing",
    reviewRounds: 0,
    buildSessionId: "s-1",
    prRef: "github:acme/web#180",
    prHeadBranch: "agent/172",
    mergeRef: null,
    escalationReason: null,
    targetChannelId: "c-1",
    targetAgentMemberId: "m-1",
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...over,
  };
}

describe("evaluateHouseRubric (#172 auto-review spine)", () => {
  it("PASSes a clean, tested, workspace-scoped, correctly-numbered diff", () => {
    const r = evaluateHouseRubric(input());
    expect(r.verdict).toBe("pass");
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("FAILs when code changes ship no test", () => {
    const r = evaluateHouseRubric(input({ files: ["apps/server/src/build-loop/engine.ts"] }));
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.id === "tests_present")?.ok).toBe(false);
  });

  it("exempts a docs-only or migration-only diff from the tests requirement", () => {
    const r = evaluateHouseRubric(input({ files: ["docs/specs/172-self-shipping-loop.md"] }));
    expect(r.checks.find((c) => c.id === "tests_present")?.ok).toBe(true);
  });

  it("FAILs a migration numbered with the wrong issue number", () => {
    const r = evaluateHouseRubric(
      input({
        files: ["apps/server/drizzle/0099_self_shipping_loop.sql", "apps/server/test/x.test.ts"],
      }),
    );
    expect(r.checks.find((c) => c.id === "migrations_numbered")?.ok).toBe(false);
  });

  it("PASSes a migration numbered by the issue number", () => {
    const r = evaluateHouseRubric(
      input({
        files: ["apps/server/drizzle/0172_self_shipping_loop.sql", "apps/server/test/x.test.ts"],
        addedLines: ["CREATE TABLE foo (workspace_id uuid NOT NULL)"],
      }),
    );
    expect(r.checks.find((c) => c.id === "migrations_numbered")?.ok).toBe(true);
  });

  it("FAILs a new table that is not workspace-scoped", () => {
    const r = evaluateHouseRubric(
      input({ addedLines: ["CREATE TABLE foo (id uuid PRIMARY KEY)"] }),
    );
    expect(r.checks.find((c) => c.id === "tenant_scoping")?.ok).toBe(false);
  });

  it("FAILs when an added line leaks a secret", () => {
    const r = evaluateHouseRubric(
      input({ addedLines: ['const key = "sk-abcdefABCDEF0123456789"'] }),
    );
    expect(r.verdict).toBe("fail");
    expect(r.checks.find((c) => c.id === "no_secrets")?.ok).toBe(false);
  });

  it("FAILs (gates_intact) a PR that touches a protected approval/billing path", () => {
    const r = evaluateHouseRubric(
      input({
        files: ["apps/server/src/approvals/policy.ts", "apps/server/test/x.test.ts"],
      }),
    );
    expect(r.checks.find((c) => c.id === "gates_intact")?.ok).toBe(false);
  });
});

describe("render (#172)", () => {
  it("extracts the issue number from a canonical ref", () => {
    expect(issueNumberOf("github:acme/web#172")).toBe(172);
    expect(issueNumberOf("local#0")).toBe(0);
  });

  it("renders a deterministic verdict comment with per-check rows", () => {
    const assessment = evaluateHouseRubric(input({ files: ["apps/server/src/x.ts"] }));
    const comment = renderVerdictComment(run({ reviewRounds: 1 }), assessment);
    expect(comment).toContain("FAIL");
    expect(comment).toContain("tests_present");
    expect(comment).toContain("round 1");
  });

  it("redacts the persisted findings via the injected redactor", () => {
    const assessment = evaluateHouseRubric(input());
    const findings = renderFindings(assessment, () => "‹redacted›");
    expect(findings).toContain("‹redacted›");
    const parsed = JSON.parse(findings) as { verdict: string };
    expect(parsed.verdict).toBe("pass");
  });

  it("maps each escalation reason to an owner-readable sentence", () => {
    expect(renderEscalationSummary(run(), "protected_path")).toContain("protected gate");
    expect(renderEscalationSummary(run(), "post_merge_regression")).toContain("PROPOSED, not executed");
  });

  it("lists only the failing checks in a revision task", () => {
    const assessment = evaluateHouseRubric(input({ files: ["apps/server/src/x.ts"] }));
    const task = renderRevisionTask(run({ reviewRounds: 1 }), assessment);
    expect(task).toContain("tests_present");
  });
});
