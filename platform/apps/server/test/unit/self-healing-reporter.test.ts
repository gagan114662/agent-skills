import { describe, it, expect } from "vitest";
import {
  composeRunbook,
  type RunbookContext,
} from "../../src/self-healing/runbook.js";
import {
  filePostmortem,
  flywheelPostmortemReporter,
  githubPostmortemReporter,
  marker,
  parseMarker,
  toFailureEvent,
  type IssueClient,
  type OpsPostmortem,
} from "../../src/self-healing/reporter.js";
import type { FailureEvent } from "../../src/flywheel/types.js";

function postmortem(over: Partial<OpsPostmortem> = {}): OpsPostmortem {
  return {
    signature: "ws1|venture-a|uptime",
    workspaceId: "ws1",
    surfaceKey: "venture-a",
    ventureLabel: "Venture A",
    signal: "uptime",
    action: "restart",
    observed: 0,
    threshold: 1,
    timeline: [{ at: "2026-06-13T03:00:00Z", event: "incident opened (uptime breach)" }],
    rootCause: "the deployment process crashed and did not restart",
    missingCheck: "a per-venture liveness probe with auto-restart (now added)",
    ...over,
  };
}

describe("composeRunbook (#193 AC2: runbook in context)", () => {
  it("includes the venture, signal, observed/threshold, action and the destructive gate warning", () => {
    const ctx: RunbookContext = {
      ventureLabel: "Venture A",
      surfaceKey: "venture-a",
      signal: "uptime",
      action: "rollback",
      observed: 0,
      threshold: 1,
      correlatedDeployId: "dep-9",
      requiresApproval: true,
    };
    const md = composeRunbook(ctx);
    expect(md).toContain("Venture A");
    expect(md).toContain("`rollback`");
    expect(md).toContain("dep-9");
    expect(md).toContain("#13 approval queue");
    expect(md).toMatch(/DESTRUCTIVE/);
  });

  it("a reversible action gets the run-it-and-verify note, not the gate warning", () => {
    const md = composeRunbook({
      ventureLabel: "V",
      surfaceKey: "v",
      signal: "uptime",
      action: "restart",
      observed: 0,
      threshold: 1,
      correlatedDeployId: null,
      requiresApproval: false,
    });
    expect(md).not.toMatch(/⛔/);
    expect(md).toContain("verify");
  });
});

describe("postmortem markers + flywheel mapping", () => {
  it("marker round-trips the signature", () => {
    expect(parseMarker(`prefix ${marker("ws1|v|uptime")} suffix`)).toBe("ws1|v|uptime");
  });

  it("maps to an ops_incident FailureEvent", () => {
    const ev: FailureEvent = toFailureEvent(postmortem());
    expect(ev.failureClass).toBe("ops_incident");
    expect(ev.workspaceId).toBe("ws1");
    expect(ev.source).toContain("venture-a");
  });
});

describe("two-reporter self-filing (#193 AC4: mirrors #171)", () => {
  function fakeIssueClient(): IssueClient & { created: number; comments: number } {
    const state = { created: 0, comments: 0 };
    return {
      created: 0,
      comments: 0,
      async createIssue() {
        state.created += 1;
        this.created = state.created;
        return { number: state.created, ref: `repo#${state.created}` };
      },
      async comment() {
        state.comments += 1;
        this.comments = state.comments;
      },
    };
  }

  it("opens once, comments on recurrence (deduped by marker)", async () => {
    const client = fakeIssueClient();
    const existing = new Map<string, string>();
    const reporter = githubPostmortemReporter({ client, existingByMarker: existing });

    expect(await reporter.report(postmortem())).toEqual({ action: "opened" });
    expect(client.created).toBe(1);
    // Same signature again in the same run ⇒ comment, never a duplicate issue.
    expect(await reporter.report(postmortem())).toEqual({ action: "commented" });
    expect(client.created).toBe(1);
    expect(client.comments).toBe(1);
  });

  it("a pre-existing open issue for the signature comments instead of opening", async () => {
    const client = fakeIssueClient();
    const reporter = githubPostmortemReporter({
      client,
      existingByMarker: new Map([["ws1|venture-a|uptime", "repo#42"]]),
    });
    expect(await reporter.report(postmortem())).toEqual({ action: "commented" });
    expect(client.created).toBe(0);
  });

  it("flywheel reporter records an ops_incident", async () => {
    const recorded: FailureEvent[] = [];
    const reporter = flywheelPostmortemReporter({
      record: async (e) => {
        recorded.push(e);
      },
    });
    expect(await reporter.report(postmortem())).toEqual({ action: "recorded" });
    expect(recorded[0]?.failureClass).toBe("ops_incident");
  });

  it("filePostmortem is fail-soft: a throwing reporter never drops the others", async () => {
    const recorded: FailureEvent[] = [];
    const throwing = { report: async () => Promise.reject(new Error("github down")) };
    const fly = flywheelPostmortemReporter({ record: async (e) => void recorded.push(e) });
    const res = await filePostmortem(postmortem(), [throwing, fly]);
    expect(res).toEqual({ reported: 1, errored: 1 });
    expect(recorded).toHaveLength(1);
  });
});
