import { describe, it, expect } from "vitest";
import { composeFailureBundle } from "../../src/sre/bundle.js";
import { draftPostmortem, postmortemPath } from "../../src/sre/postmortem.js";
import type { BundleContext, IncidentRecord } from "../../src/sre/types.js";

const incident: IncidentRecord = {
  id: "11111111-2222-3333-4444-555555555555",
  workspaceId: "ws-1",
  service: "api",
  sloKind: "latency_p95",
  severity: "critical",
  status: "firing",
  observedValue: 1200,
  targetValue: 500,
  budgetRemaining: 0,
  triageSessionId: null,
  postmortemPath: null,
  openedAt: new Date("2026-06-10T12:00:00Z"),
  resolvedAt: null,
};

const ctx: BundleContext = {
  recentDeploys: [{ id: "dep-9", target: "vercel", status: "succeeded", at: "2026-06-10T11:30:00Z" }],
  traceHints: ["trace-abc", "trace-def"],
  runbookLinks: ["docs/playbooks/restore-runbook.md"],
};

describe("composeFailureBundle", () => {
  it("is a data prompt carrying the breach, deploys, trace hints, and runbook links", () => {
    const bundle = composeFailureBundle(incident, ctx);
    expect(bundle).toContain("api");
    expect(bundle).toContain("latency_p95");
    expect(bundle).toContain("1200");
    expect(bundle).toContain("500");
    expect(bundle).toContain("dep-9");
    expect(bundle).toContain("trace-abc");
    expect(bundle).toContain("docs/playbooks/restore-runbook.md");
  });

  it("does not require any deploys/hints (degrades gracefully)", () => {
    const bundle = composeFailureBundle(incident, {
      recentDeploys: [],
      traceHints: [],
      runbookLinks: [],
    });
    expect(bundle).toContain("api");
    expect(typeof bundle).toBe("string");
  });
});

describe("postmortemPath", () => {
  it("builds a stable docs/postmortems path from the incident", () => {
    const p = postmortemPath(incident, "2026-06-10");
    expect(p).toBe("docs/postmortems/2026-06-10-api-latency_p95-11111111.md");
  });

  it("sanitizes an unusual service name", () => {
    const p = postmortemPath({ ...incident, service: "my svc/01" }, "2026-06-10");
    expect(p).toMatch(/^docs\/postmortems\/2026-06-10-my-svc-01-/);
    expect(p).not.toContain("/01.md"); // slashes in the name never break the path
  });
});

describe("draftPostmortem", () => {
  it("renders a timeline + 5-whys skeleton markdown", () => {
    const md = draftPostmortem({ ...incident, status: "resolved", resolvedAt: new Date("2026-06-10T12:30:00Z") }, [
      { at: "2026-06-10T12:00:00Z", event: "incident opened (latency_p95 breached)" },
      { at: "2026-06-10T12:05:00Z", event: "triage agent launched" },
      { at: "2026-06-10T12:30:00Z", event: "SLO recovered — incident resolved" },
    ]);
    expect(md).toContain("# Postmortem");
    expect(md).toContain("## Timeline");
    expect(md).toContain("triage agent launched");
    expect(md).toContain("## 5 Whys");
    expect(md).toContain("api"); // service named
    expect(md.match(/Why/g)!.length).toBeGreaterThanOrEqual(5);
  });
});
