/**
 * Unit tests for the conflict-resolution service (#587) over the in-memory store. Exercises the full lifecycle —
 * arbitrate → persist → (escalate) human decide — plus workspace (IDOR) scoping, escalation expiry, the
 * not-a-candidate guard, and the single-use decide guard.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ConflictResolutionService,
  ConflictResolutionError,
  shippableProposalId,
} from "../../src/conflict-resolution/service.js";
import { InMemoryConflictStore } from "../../src/conflict-resolution/store.js";
import {
  CONFLICT_RESOLUTION_DEFAULTS,
  type ConflictResolutionCaps,
} from "../../src/conflict-resolution/caps.js";
import type { Proposal } from "../../src/conflict-resolution/types.js";

const WID = "ws-1";
const OTHER_WID = "ws-2";
const OWNER = "member-owner";

const CAPS: ConflictResolutionCaps = { ...CONFLICT_RESOLUTION_DEFAULTS, decisionTtlMs: 1_000 };

function svc(now: () => Date = () => new Date(0)) {
  return new ConflictResolutionService({ store: new InMemoryConflictStore(), caps: CAPS, now });
}

function p(over: Partial<Proposal> & Pick<Proposal, "id" | "strategy">): Proposal {
  return { objectiveId: "obj-1", agentId: `agent-${over.id}`, ...over };
}

const CLOSE_CONFLICT: Proposal[] = [
  p({ id: "x", strategy: "founder-led", briefAlignment: 0.7, expectedImpact: 0.6 }),
  p({ id: "y", strategy: "product-led", briefAlignment: 0.69, expectedImpact: 0.61 }),
];

const DECISIVE_CONFLICT: Proposal[] = [
  p({ id: "winner", strategy: "value-anchored", briefAlignment: 0.95, expectedImpact: 0.9 }),
  p({ id: "loser", strategy: "discount-led", briefAlignment: 0.2, expectedImpact: 0.2 }),
];

describe("ConflictResolutionService (#587)", () => {
  let service: ConflictResolutionService;
  beforeEach(() => {
    service = svc();
  });

  it("persists an auto-pick as a terminal auto_resolved record with one winner", async () => {
    const { resolution, record } = await service.arbitrate({ workspaceId: WID, proposals: DECISIVE_CONFLICT });
    expect(resolution.outcome).toBe("pick");
    expect(record.status).toBe("auto_resolved");
    expect(record.winnerProposalId).toBe("winner");
    expect(shippableProposalId(record)).toBe("winner");
  });

  it("parks a close conflict as escalated with NOTHING shippable, snapshotting candidates", async () => {
    const { resolution, record } = await service.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    expect(resolution.outcome).toBe("escalate");
    expect(record.status).toBe("escalated");
    expect(record.winnerProposalId).toBeNull();
    expect(shippableProposalId(record)).toBeNull();
    expect(record.candidates.map((c) => c.id).sort()).toEqual(["x", "y"]);
    expect(await service.list(WID, "escalated")).toHaveLength(1);
  });

  it("a human decision on an escalation yields exactly one shippable proposal", async () => {
    const { record } = await service.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    const decided = await service.decide(WID, record.id, OWNER, "y", "founder voice is off-brand here");
    expect(decided.status).toBe("resolved");
    expect(decided.decidedByMemberId).toBe(OWNER);
    expect(shippableProposalId(decided)).toBe("y");
  });

  it("refuses a decision for a proposal that is not a candidate", async () => {
    const { record } = await service.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    await expect(service.decide(WID, record.id, OWNER, "not-a-candidate")).rejects.toBeInstanceOf(
      ConflictResolutionError,
    );
  });

  it("refuses a second decision on an already-resolved conflict (single-use)", async () => {
    const { record } = await service.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    await service.decide(WID, record.id, OWNER, "x");
    await expect(service.decide(WID, record.id, OWNER, "y")).rejects.toThrow(/already resolved/i);
  });

  it("scopes reads and decisions to the owning workspace (#3 IDOR)", async () => {
    const { record } = await service.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    expect(await service.get(OTHER_WID, record.id)).toBeNull();
    await expect(service.decide(OTHER_WID, record.id, OWNER, "x")).rejects.toThrow(/no such conflict/i);
  });

  it("lazily expires an escalation past its TTL — and an expired conflict ships nothing", async () => {
    let nowMs = 0;
    const s = new ConflictResolutionService({
      store: new InMemoryConflictStore(),
      caps: CAPS,
      now: () => new Date(nowMs),
    });
    const { record } = await s.arbitrate({ workspaceId: WID, proposals: CLOSE_CONFLICT });
    nowMs = CAPS.decisionTtlMs + 1; // advance past the TTL
    const read = await s.get(WID, record.id);
    expect(read?.status).toBe("expired");
    expect(shippableProposalId(read!)).toBeNull();
    await expect(s.decide(WID, record.id, OWNER, "x")).rejects.toThrow(/expired/i);
  });

  it("preview runs the verdict without persisting anything", async () => {
    const resolution = service.preview(DECISIVE_CONFLICT);
    expect(resolution.outcome).toBe("pick");
    expect(await service.list(WID)).toHaveLength(0);
  });
});
