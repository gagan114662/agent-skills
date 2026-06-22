import { describe, it, expect } from "vitest";
import { defaultRoleRegistry } from "../../src/agent-roles/registry.js";
import { routeTask, KIND_WEIGHT } from "../../src/agent-roles/route.js";

const reg = defaultRoleRegistry();

describe("agent-roles/route — explicit kind", () => {
  it("routes a kind-tagged task to the owning role regardless of text", () => {
    const d = routeTask({ description: "do the thing", kind: "distribution" }, reg);
    expect(d.role).toBe("distributor");
    expect(d.confidence).toBe("high");
    expect(d.ranked[0].reasons.join(" ")).toContain(`+${KIND_WEIGHT}`);
  });

  it("each kind routes to its canonical role", () => {
    expect(routeTask({ description: "x", kind: "research" }, reg).role).toBe("scout");
    expect(routeTask({ description: "x", kind: "strategy" }, reg).role).toBe("strategist");
    expect(routeTask({ description: "x", kind: "drafting" }, reg).role).toBe("writer");
    expect(routeTask({ description: "x", kind: "distribution" }, reg).role).toBe("distributor");
    expect(routeTask({ description: "x", kind: "analysis" }, reg).role).toBe("analyst");
  });
});

describe("agent-roles/route — keyword routing (no kind)", () => {
  it("routes 'find prospects' to the scout", () => {
    const d = routeTask({ description: "Find new prospects in fintech and enrich them" }, reg);
    expect(d.role).toBe("scout");
    expect(d.ranked[0].matchedKeywords).toContain("prospects");
  });

  it("routes 'draft the email copy' to the writer", () => {
    const d = routeTask({ description: "Draft the email copy and a punchy subject line" }, reg);
    expect(d.role).toBe("writer");
  });

  it("routes 'measure conversion and report attribution' to the analyst", () => {
    const d = routeTask({ description: "Measure conversion and report on attribution" }, reg);
    expect(d.role).toBe("analyst");
  });

  it("routes 'schedule and send across channels' to the distributor", () => {
    const d = routeTask({ description: "Schedule and send this across all channels" }, reg);
    expect(d.role).toBe("distributor");
  });

  it("routes 'segment the audience and prioritize' to the strategist", () => {
    const d = routeTask({ description: "Segment the audience and prioritize the approach" }, reg);
    expect(d.role).toBe("strategist");
  });

  it("matches keywords as whole words, not substrings", () => {
    // "sender" contains "send" as a substring but is not the token "send".
    const d = routeTask({ description: "the sender address is wrong" }, reg);
    expect(d.ranked.find((s) => s.role === "distributor")?.matchedKeywords).not.toContain("send");
  });
});

describe("agent-roles/route — capability filter", () => {
  it("disqualifies roles not allowed a required tool", () => {
    const d = routeTask(
      { description: "send this out", requiredTools: ["email.send"] },
      reg,
    );
    expect(d.role).toBe("distributor");
    // Every non-distributor is ineligible because it lacks email.send.
    for (const s of d.ranked.filter((r) => r.role !== "distributor")) {
      expect(s.eligible).toBe(false);
      expect(s.score).toBe(0);
    }
  });

  it("returns role=null when no role is allowed the required tool", () => {
    const d = routeTask(
      { description: "do something", requiredTools: ["nonexistent.tool"] },
      reg,
    );
    expect(d.role).toBeNull();
    expect(d.confidence).toBe("none");
    expect(d.rationale).toContain("nonexistent.tool");
    expect(d.ranked.every((s) => !s.eligible)).toBe(true);
  });

  it("a kind match still loses to the capability filter (scope wins)", () => {
    // research kind would point at scout, but scout may not use email.send.
    const d = routeTask(
      { description: "research then notify", kind: "research", requiredTools: ["email.send"] },
      reg,
    );
    expect(d.ranked.find((s) => s.role === "scout")?.eligible).toBe(false);
    expect(d.role).not.toBe("scout");
  });
});

describe("agent-roles/route — no signal", () => {
  it("returns role=null for text with no kind and no keyword match", () => {
    const d = routeTask({ description: "lorem ipsum dolor sit amet" }, reg);
    expect(d.role).toBeNull();
    expect(d.confidence).toBe("none");
    expect(d.rationale).toMatch(/needs explicit routing/);
  });
});

describe("agent-roles/route — determinism & explainability", () => {
  it("produces an identical decision for identical inputs", () => {
    const task = { description: "Find prospects and draft an email" } as const;
    expect(routeTask(task, reg)).toEqual(routeTask(task, reg));
  });

  it("ranked is sorted best-first and covers every role", () => {
    const d = routeTask({ description: "find prospects" }, reg);
    expect(d.ranked).toHaveLength(reg.roleIds().length);
    for (let i = 1; i < d.ranked.length; i++) {
      expect(d.ranked[i - 1].score).toBeGreaterThanOrEqual(d.ranked[i].score);
    }
  });

  it("the winning decision carries human-readable reasons", () => {
    const d = routeTask({ description: "find prospects", kind: "research" }, reg);
    expect(d.rationale).toContain("scout");
    expect(d.ranked[0].reasons.length).toBeGreaterThan(0);
  });

  it("breaks score ties by roster order", () => {
    // "post" is a keyword for both writer and distributor (+1 each); writer sorts first by roster order.
    const d = routeTask({ description: "a post" }, reg);
    const writer = d.ranked.find((s) => s.role === "writer")!;
    const distributor = d.ranked.find((s) => s.role === "distributor")!;
    expect(writer.score).toBe(distributor.score);
    expect(d.role).toBe("writer");
  });
});
