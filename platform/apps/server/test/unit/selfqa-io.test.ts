import { describe, it, expect, vi } from "vitest";
import { httpSmokeDriver, noopDriver, resolveDriver } from "../../src/selfqa/driver.js";
import { SelfQaRunner } from "../../src/selfqa/runner.js";
import { SelfQaEngine } from "../../src/selfqa/engine.js";
import { reportFindings, type IssueClient, githubReporter, flywheelReporter } from "../../src/selfqa/bridge.js";
import { resolveSelfqaCaps, SELFQA_DEFAULTS } from "../../src/selfqa/caps.js";
import { classifyResults } from "../../src/selfqa/classify.js";
import { QA_CATALOG, checksForSuite, getCheck } from "../../src/selfqa/catalog.js";
import { parseSelfqaMarker } from "../../src/selfqa/render.js";
import type { QaBrowserDriver, RawCheckResult } from "../../src/selfqa/types.js";

/** Self-QA loop (#171) — the IO seams: driver, runner gating + isolation, and the two reporters. */

// ---- caps --------------------------------------------------------------------------------------

describe("resolveSelfqaCaps", () => {
  it("is OFF by default with a reserved synthetic-workspace slug", () => {
    const caps = resolveSelfqaCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.workspaceSlug).toBe(SELFQA_DEFAULTS.workspaceSlug);
    expect(caps.workspaceSlug.length).toBeGreaterThan(0);
  });
  it("lets a config layer flip enabled and the slug", () => {
    const caps = resolveSelfqaCaps({ enabled: true, workspaceSlug: "qa-bot" });
    expect(caps.enabled).toBe(true);
    expect(caps.workspaceSlug).toBe("qa-bot");
  });
});

// ---- driver ------------------------------------------------------------------------------------

describe("httpSmokeDriver", () => {
  const okFetch = vi.fn(async () => new Response("<html><body>console</body></html>", { status: 200 }));

  it("passes a reachability check when the target responds 2xx", async () => {
    const driver = httpSmokeDriver(okFetch as unknown as typeof fetch);
    const res = await driver.run(getCheck("auth-sign-in")!, { target: "https://ipop.ai" });
    expect(res.ok).toBe(true);
  });

  it("fails the check (never throws) when the target errors or returns 5xx", async () => {
    const downFetch = vi.fn(async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
    const driver = httpSmokeDriver(downFetch);
    const res = await driver.run(getCheck("auth-sign-in")!, { target: "https://ipop.ai" });
    expect(res.ok).toBe(false);
    expect(res.actual).toBeTruthy();
  });

  it("turns a thrown fetch (DNS/timeout) into a failed result, not a crash", async () => {
    const throwFetch = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    const res = await httpSmokeDriver(throwFetch).run(getCheck("layout-no-overflow")!, { target: "https://ipop.ai" });
    expect(res.ok).toBe(false);
  });

  it("resolveDriver returns the no-op for an unknown/none name and never a real browser", () => {
    expect(resolveDriver("none")).toBe(noopDriver);
    expect(resolveDriver(undefined)).toBe(noopDriver);
  });
});

// ---- runner: gating + tenant isolation ---------------------------------------------------------

/** A driver that fails exactly the named checks (everything else passes). */
function failingDriver(failIds: string[]): QaBrowserDriver {
  return {
    run: async (check): Promise<RawCheckResult> =>
      failIds.includes(check.id) ? { checkId: check.id, ok: false, actual: "synthetic failure" } : { checkId: check.id, ok: true },
  };
}

const ENABLED = { enabled: true, workspaceSlug: "selfqa-system" } as const;

describe("SelfQaRunner", () => {
  it("skips entirely when the loop is disabled (default-OFF)", async () => {
    const runner = new SelfQaRunner({
      driver: noopDriver,
      caps: () => resolveSelfqaCaps(undefined),
      isSyntheticWorkspace: () => true,
    });
    const result = await runner.run({ suite: "smoke", target: "https://ipop.ai", workspaceId: "ws" });
    expect(result.skipped).toBe("disabled");
    expect(result.findings).toHaveLength(0);
  });

  it("REFUSES to run against a non-synthetic workspace (never touches a real tenant)", async () => {
    const runner = new SelfQaRunner({
      driver: failingDriver(["auth-sign-in"]),
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => false, // a real tenant
    });
    const result = await runner.run({ suite: "smoke", target: "https://ipop.ai", workspaceId: "real-tenant" });
    expect(result.skipped).toBe("wrong_workspace");
    expect(result.findings).toHaveLength(0);
  });

  it("skips when the kill switch is engaged", async () => {
    const runner = new SelfQaRunner({
      driver: noopDriver,
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => true,
      killSwitch: async () => true,
    });
    const result = await runner.run({ suite: "smoke", target: "https://ipop.ai", workspaceId: "selfqa" });
    expect(result.skipped).toBe("kill_switch");
  });

  it("skips when maintenance mode is active (before any work)", async () => {
    const runner = new SelfQaRunner({
      driver: noopDriver,
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => true,
      maintenancePaused: async () => true,
    });
    const result = await runner.run({ suite: "smoke", target: "https://ipop.ai", workspaceId: "selfqa" });
    expect(result.skipped).toBe("maintenance");
  });

  it("runs the suite's checks and classifies the failures into findings", async () => {
    const runner = new SelfQaRunner({
      driver: failingDriver(["layout-no-overflow", "composer-send-button"]),
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => true,
    });
    const result = await runner.run({ suite: "smoke", target: "https://ipop.ai", workspaceId: "selfqa" });
    expect(result.skipped).toBeUndefined();
    const ids = result.findings.map((f) => f.checkId).sort();
    expect(ids).toEqual(["composer-send-button", "layout-no-overflow"]);
    expect(result.summary.checksTotal).toBe(checksForSuite("smoke").length);
    expect(result.summary.checksFailed).toBe(2);
  });
});

// ---- bridge: github reporter (stateless dedup) -------------------------------------------------

function fakeIssueClient() {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const comments: Array<{ ref: string; body: string }> = [];
  const client: IssueClient = {
    createIssue: async (input) => {
      created.push(input);
      return { number: created.length, ref: `github:acme/web#${created.length}` };
    },
    comment: async (ref, body) => {
      comments.push({ ref, body });
    },
  };
  return { client, created, comments };
}

const findingFor = (checkId: string, actual = "boom") => classifyResults([{ checkId, ok: false, actual }], QA_CATALOG)[0]!;

describe("githubReporter — opens once, comments on recurrence, never spams", () => {
  it("opens a new issue with the surface/severity labels and the dedup marker for a first-seen finding", async () => {
    const { client, created } = fakeIssueClient();
    const reporter = githubReporter({ client, existingByMarker: new Map() });
    const f = findingFor("layout-no-overflow");
    const r = await reporter.report(f, { target: "https://ipop.ai", workspaceSlug: "selfqa-system" });
    expect(r.action).toBe("opened");
    expect(created).toHaveLength(1);
    expect(created[0]!.labels).toContain("selfqa:layout");
    expect(created[0]!.labels).toContain("severity:high");
    expect(parseSelfqaMarker(created[0]!.body)).toBe(f.signature);
  });

  it("comments on the EXISTING issue when a finding with the same signature is already open (no duplicate)", async () => {
    const { client, created, comments } = fakeIssueClient();
    const f = findingFor("layout-no-overflow");
    const reporter = githubReporter({ client, existingByMarker: new Map([[f.signature, "github:acme/web#7"]]) });
    const r = await reporter.report(f, {});
    expect(r.action).toBe("commented");
    expect(created).toHaveLength(0); // never opens a duplicate
    expect(comments).toHaveLength(1);
    expect(comments[0]!.ref).toBe("github:acme/web#7");
  });
});

// ---- bridge: flywheel reporter ----------------------------------------------------------------

describe("flywheelReporter — flows findings through the #117 ledger", () => {
  it("records a qa_failure FailureEvent for the synthetic workspace", async () => {
    const recorded: unknown[] = [];
    const reporter = flywheelReporter({ workspaceId: "ws-synth", record: async (e) => void recorded.push(e) });
    const r = await reporter.report(findingFor("sessions-produce-replies"), {});
    expect(r.action).toBe("recorded");
    expect(recorded).toHaveLength(1);
    expect((recorded[0] as { failureClass: string }).failureClass).toBe("qa_failure");
  });
});

// ---- reportFindings orchestration: critical paging --------------------------------------------

describe("reportFindings", () => {
  it("reports every finding and pages the owner ONLY for critical severity", async () => {
    const { client } = fakeIssueClient();
    const reporter = githubReporter({ client, existingByMarker: new Map() });
    const paged: string[] = [];
    const findings = [findingFor("sessions-produce-replies"), findingFor("layout-no-overflow")]; // critical + high
    const out = await reportFindings(findings, {
      reporter,
      target: "https://ipop.ai",
      workspaceSlug: "selfqa-system",
      pageOwner: async (f) => void paged.push(f.checkId),
    });
    expect(out.reported).toBe(2);
    expect(paged).toEqual(["sessions-produce-replies"]); // only the critical one
  });

  it("never lets a reporter error abort the rest of the run", async () => {
    const reporter = {
      report: vi.fn(async (f: { checkId: string }) => {
        if (f.checkId === "auth-sign-in") throw new Error("github 500");
        return { action: "opened" as const };
      }),
    };
    const findings = [findingFor("auth-sign-in"), findingFor("layout-no-overflow")];
    const out = await reportFindings(findings, { reporter, target: "x", workspaceSlug: "s" });
    expect(out.reported).toBe(1); // the second still went through
    expect(out.errored).toBe(1);
  });
});

// ---- engine: end-to-end orchestration (fakes, no DB) ------------------------------------------

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

describe("SelfQaEngine.runOnce", () => {
  it("resolves the synthetic workspace, runs, reports findings, pages criticals and records the run", async () => {
    const recorded: unknown[] = [];
    const paged: string[] = [];
    const started: unknown[] = [];
    const finished: unknown[] = [];
    const runner = new SelfQaRunner({
      driver: failingDriver(["sessions-produce-replies"]), // a critical failure
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => true,
    });
    const engine = new SelfQaEngine({
      runner,
      caps: () => resolveSelfqaCaps(ENABLED),
      target: "https://ipop.ai",
      resolveSyntheticWorkspaceId: async () => "ws-synth",
      reporter: (workspaceId) => flywheelReporter({ workspaceId, record: async (e) => void recorded.push(e) }),
      pageOwner: async (_ws, f) => void paged.push(f.checkId),
      persist: {
        start: async (i) => {
          started.push(i);
          return { id: "run-1" };
        },
        finish: async (i) => void finished.push(i),
      },
      logger: silentLogger,
    });

    const out = await engine.runOnce("smoke");
    expect(out.workspaceId).toBe("ws-synth");
    expect(out.reported).toBe(1);
    expect(paged).toEqual(["sessions-produce-replies"]); // critical paged the owner
    expect(recorded).toHaveLength(1); // flowed through the flywheel ledger
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
  });

  it("is a clean no-op when the synthetic workspace does not exist", async () => {
    const runner = new SelfQaRunner({
      driver: noopDriver,
      caps: () => resolveSelfqaCaps(ENABLED),
      isSyntheticWorkspace: () => true,
    });
    const engine = new SelfQaEngine({
      runner,
      caps: () => resolveSelfqaCaps(ENABLED),
      target: "https://ipop.ai",
      resolveSyntheticWorkspaceId: async () => null, // not provisioned
      reporter: () => ({ report: async () => ({ action: "noop" as const }) }),
      logger: silentLogger,
    });
    const out = await engine.runOnce("full");
    expect(out.workspaceId).toBeNull();
    expect(out.reported).toBe(0);
  });
});
