import { describe, it, expect } from "vitest";
import {
  resolveOzLoopsCaps,
  isOzLoopsEnabledForWorkspace,
  OZ_LOOPS_DEFAULTS,
  type OzLoopsCaps,
} from "../../src/oz-loops/caps.js";
import { OzLoopsService, type OzLoopsDeps } from "../../src/oz-loops/service.js";
import type { OzProposal } from "../../src/oz-loops/contract.js";

const OWNER = "ws-owner";
const identity = { workspaceId: OWNER, requesterMemberId: "m-1" };

function enabledCaps(over: Partial<OzLoopsCaps> = {}): OzLoopsCaps {
  return { ...OZ_LOOPS_DEFAULTS, enabled: true, ownerWorkspaceId: OWNER, ...over };
}

function makeService(caps: OzLoopsCaps): {
  service: OzLoopsService;
  staged: { workspaceId: string; proposal: OzProposal }[];
} {
  const staged: { workspaceId: string; proposal: OzProposal }[] = [];
  const deps: OzLoopsDeps = {
    caps: () => caps,
    stage: async (input) => {
      staged.push({ workspaceId: input.workspaceId, proposal: input.proposal });
      return { id: `req-${staged.length}` };
    },
  };
  return { service: new OzLoopsService(deps), staged };
}

describe("oz-loops caps (#356 default OFF, owner-first)", () => {
  it("hard default is OFF", () => {
    expect(resolveOzLoopsCaps(undefined).enabled).toBe(false);
    expect(isOzLoopsEnabledForWorkspace(resolveOzLoopsCaps(undefined), OWNER)).toBe(false);
  });

  it("enabled WITHOUT naming an owner runs for nobody (owner-first default)", () => {
    const caps = resolveOzLoopsCaps({ enabled: true });
    expect(isOzLoopsEnabledForWorkspace(caps, OWNER)).toBe(false);
    expect(isOzLoopsEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("enabled + owner named runs only for the owner workspace", () => {
    const caps = resolveOzLoopsCaps({ enabled: true, ownerWorkspaceId: OWNER });
    expect(isOzLoopsEnabledForWorkspace(caps, OWNER)).toBe(true);
    expect(isOzLoopsEnabledForWorkspace(caps, "ws-other")).toBe(false);
  });

  it("ownerWorkspaceOnly:false opens it to all tenants when enabled", () => {
    const caps = resolveOzLoopsCaps({ enabled: true, ownerWorkspaceOnly: false });
    expect(isOzLoopsEnabledForWorkspace(caps, "ws-anyone")).toBe(true);
  });

  it("fills numeric bounds from config or defaults", () => {
    expect(resolveOzLoopsCaps({ maxFindings: 3 }).maxFindings).toBe(3);
    expect(resolveOzLoopsCaps(undefined).maxDiffChars).toBe(OZ_LOOPS_DEFAULTS.maxDiffChars);
  });
});

describe("OzLoopsService (#356)", () => {
  it("fail-closed: disabled workspace produces nothing", () => {
    const { service } = makeService({ ...OZ_LOOPS_DEFAULTS, enabled: false });
    const res = service.run(identity, { kind: "triage", input: { number: 1, title: "bug", body: "error" } });
    expect(res.enabled).toBe(false);
    expect(res.proposal).toBeNull();
  });

  it("runs a loop when enabled and returns an advisory proposal (no side effect)", () => {
    const { service, staged } = makeService(enabledCaps());
    const res = service.run(identity, { kind: "triage", input: { number: 1, title: "crash", body: "boom" } });
    expect(res.enabled).toBe(true);
    expect(res.proposal?.kind).toBe("triage");
    expect(res.proposal?.advisory).toBe(true);
    // run() never stages — producing a proposal is not an action.
    expect(staged).toHaveLength(0);
  });

  it("threads caps bounds into the review loop", () => {
    const { service } = makeService(enabledCaps({ maxFindings: 1 }));
    const lines = ["+++ b/src/x.ts"];
    for (let i = 0; i < 6; i++) lines.push(`+ console.log(${i})`);
    const res = service.run(identity, { kind: "review", input: { prNumber: 1, title: "x", diff: lines.join("\n") } });
    expect(res.proposal?.kind).toBe("review");
    if (res.proposal?.kind === "review") expect(res.proposal.findings.length).toBeLessThanOrEqual(1);
  });

  it("requestPublish parks a PENDING #13 request — the ONLY outward path", async () => {
    const { service, staged } = makeService(enabledCaps());
    const res = service.run(identity, { kind: "spec", input: { title: "x", body: "y", specKind: "tech" } });
    const pub = await service.requestPublish(identity, res.proposal!);
    expect(pub.enabled).toBe(true);
    expect(pub.requestId).toBe("req-1");
    expect(staged).toHaveLength(1);
    expect(staged[0]?.proposal.kind).toBe("spec");
  });

  it("requestPublish is fail-closed when the loops are disabled (never stages)", async () => {
    const proposal: OzProposal = {
      kind: "triage",
      advisory: true,
      injectionFlagged: false,
      suggestedLabels: [],
      severity: "unknown",
      likelyDuplicateOf: [],
      rationale: "x",
      summary: "x",
    };
    const { service, staged } = makeService({ ...OZ_LOOPS_DEFAULTS, enabled: false });
    const pub = await service.requestPublish(identity, proposal);
    expect(pub.enabled).toBe(false);
    expect(pub.requestId).toBeNull();
    expect(staged).toHaveLength(0);
  });
});
