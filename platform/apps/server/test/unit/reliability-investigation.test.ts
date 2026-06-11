import { describe, it, expect } from "vitest";
import {
  correlateIncident,
  type CorrelateInput,
} from "../../src/reliability/investigation/correlate.js";
import { renderInvestigationNote } from "../../src/reliability/investigation/render.js";

const OPENED = new Date("2026-06-11T12:00:00Z");

function base(overrides: Partial<CorrelateInput> = {}): CorrelateInput {
  return {
    incident: {
      service: "api",
      sloKind: "availability",
      severity: "critical",
      observedValue: 0.4,
      targetValue: 0.99,
      openedAt: OPENED,
    },
    recentDeploys: [],
    fingerprints: [],
    saturation: null,
    deployWindowMs: 30 * 60_000,
    ...overrides,
  };
}

describe("correlateIncident — recent deploy", () => {
  it("flags a deploy inside the pre-incident window as a likely cause", () => {
    const note = correlateIncident(
      base({
        recentDeploys: [
          { id: "dep-1", target: "vercel", status: "ready", at: new Date("2026-06-11T11:52:00Z") },
        ],
      }),
    );
    const cause = note.likelyCauses.find((c) => c.kind === "recent_deploy");
    expect(cause).toBeTruthy();
    expect(cause!.confidence).toBe("high"); // 8 min before → strong suspect
    expect(cause!.detail).toContain("dep-1");
    expect(cause!.suggestedNextStep.toLowerCase()).toContain("roll");
  });

  it("ignores a deploy older than the window", () => {
    const note = correlateIncident(
      base({
        recentDeploys: [
          { id: "old", target: "vercel", status: "ready", at: new Date("2026-06-11T11:00:00Z") }, // 60 min before
        ],
      }),
    );
    expect(note.likelyCauses.find((c) => c.kind === "recent_deploy")).toBeUndefined();
  });

  it("ignores a deploy AFTER the incident opened", () => {
    const note = correlateIncident(
      base({
        recentDeploys: [
          { id: "after", target: "vercel", status: "ready", at: new Date("2026-06-11T12:05:00Z") },
        ],
      }),
    );
    expect(note.likelyCauses.find((c) => c.kind === "recent_deploy")).toBeUndefined();
  });
});

describe("correlateIncident — saturation", () => {
  it("flags critical saturation as a high-confidence cause", () => {
    const note = correlateIncident(base({ saturation: { status: "critical", resource: "event_loop", value: 0.9 } }));
    const cause = note.likelyCauses.find((c) => c.kind === "resource_saturation");
    expect(cause!.confidence).toBe("high");
    expect(cause!.detail).toContain("event_loop");
  });

  it("flags warn saturation only as low confidence", () => {
    const note = correlateIncident(base({ saturation: { status: "warn", resource: "memory" } }));
    expect(note.likelyCauses.find((c) => c.kind === "resource_saturation")!.confidence).toBe("low");
  });

  it("ignores ok saturation", () => {
    const note = correlateIncident(base({ saturation: { status: "ok" } }));
    expect(note.likelyCauses.find((c) => c.kind === "resource_saturation")).toBeUndefined();
  });
});

describe("correlateIncident — recurring failure fingerprints", () => {
  it("flags a recurring unresolved fingerprint, confidence scaling with count", () => {
    const note = correlateIncident(
      base({
        fingerprints: [
          { signature: "sig-a", failureClass: "timeout", occurrenceCount: 12, status: "open" },
          { signature: "sig-b", failureClass: "oom", occurrenceCount: 2, status: "open" },
        ],
      }),
    );
    const causes = note.likelyCauses.filter((c) => c.kind === "recurring_failure");
    expect(causes).toHaveLength(2);
    expect(causes.find((c) => c.detail.includes("sig-a"))!.confidence).toBe("high");
    expect(causes.find((c) => c.detail.includes("sig-b"))!.confidence).toBe("low");
  });

  it("ignores a one-off or resolved fingerprint", () => {
    const note = correlateIncident(
      base({
        fingerprints: [
          { signature: "once", failureClass: "x", occurrenceCount: 1, status: "open" },
          { signature: "done", failureClass: "y", occurrenceCount: 9, status: "resolved" },
        ],
      }),
    );
    expect(note.likelyCauses.filter((c) => c.kind === "recurring_failure")).toHaveLength(0);
  });
});

describe("correlateIncident — synthesis", () => {
  it("ranks causes high→low and headlines the top one", () => {
    const note = correlateIncident(
      base({
        recentDeploys: [{ id: "dep-1", target: "vercel", status: "ready", at: new Date("2026-06-11T11:58:00Z") }],
        saturation: { status: "warn", resource: "memory" },
      }),
    );
    expect(note.likelyCauses[0].confidence).toBe("high"); // deploy first
    expect(note.likelyCauses[note.likelyCauses.length - 1].confidence).toBe("low"); // warn saturation last
    expect(note.summary).toContain("dep-1");
  });

  it("returns an explicit no-signal summary when nothing correlates", () => {
    const note = correlateIncident(base());
    expect(note.likelyCauses).toHaveLength(0);
    expect(note.summary.toLowerCase()).toContain("no correlated signal");
    expect(note.nextSteps.length).toBeGreaterThan(0); // always offers manual triage
  });

  it("dedupes suggested next steps and keeps them advisory", () => {
    const note = correlateIncident(
      base({
        fingerprints: [
          { signature: "a", failureClass: "t", occurrenceCount: 5, status: "open" },
          { signature: "b", failureClass: "t", occurrenceCount: 4, status: "open" },
        ],
      }),
    );
    const unique = new Set(note.nextSteps);
    expect(unique.size).toBe(note.nextSteps.length); // no duplicates
  });
});

describe("renderInvestigationNote", () => {
  it("renders a markdown note with the headline, causes, and an advisory footer", () => {
    const note = correlateIncident(
      base({ recentDeploys: [{ id: "dep-9", target: "fly", status: "ready", at: new Date("2026-06-11T11:55:00Z") }] }),
    );
    const md = renderInvestigationNote(note);
    expect(md).toContain("AI investigation");
    expect(md).toContain("dep-9");
    expect(md.toLowerCase()).toContain("suggestion"); // advisory framing present
    expect(md.toLowerCase()).toContain("approval"); // gates-intact reminder
  });
});
