import { describe, it, expect } from "vitest";

import {
  HandoffNotFoundError,
  HandoffService,
  HandoffStateError,
  HandoffValidationError,
  InMemoryHandoffStore,
  UnstructuredHandoffError,
  validateContract,
  validateProposal,
  type HandoffContract,
  type HandoffProposal,
} from "../../src/agent-handoff/index.js";

/** A monotonic, deterministic clock so stamped timestamps are pinned in tests. */
function fixedClock(startMs = Date.parse("2026-06-22T00:00:00.000Z")) {
  let t = startMs;
  return () => new Date((t += 1000));
}

/** Deterministic, sequential ids so a proposed handoff's id is predictable in a test. */
function seqIds(prefix = "h") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

function makeService() {
  return new HandoffService({ store: new InMemoryHandoffStore(), clock: fixedClock(), idGenerator: seqIds() });
}

function proposal(over: Partial<HandoffProposal> = {}): HandoffProposal {
  return {
    workspaceId: "ws1",
    fromAgent: "scout",
    toAgent: "quill",
    artifactRef: { type: "blog_post", id: "launch-draft" },
    intent: "review",
    acceptanceCriteria: ["no factual errors", "tone matches brand"],
    ...over,
  };
}

describe("validateProposal (#584 schema)", () => {
  it("accepts a well-formed proposal and normalizes it", () => {
    const r = validateProposal(proposal({ note: "  please  prioritize\n " }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fromAgent).toBe("scout");
      expect(r.value.acceptanceCriteria).toEqual(["no factual errors", "tone matches brand"]);
      expect(r.value.note).toBe("please prioritize"); // sanitized
    }
  });

  it("strips a leading @ from handles", () => {
    const r = validateProposal(proposal({ fromAgent: "@scout", toAgent: "@quill" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.fromAgent).toBe("scout");
      expect(r.value.toAgent).toBe("quill");
    }
  });

  it("rejects non-object input", () => {
    expect(validateProposal("hand this to quill").ok).toBe(false);
    expect(validateProposal(null).ok).toBe(false);
    expect(validateProposal(["a"]).ok).toBe(false);
  });

  it("rejects an agent handing off to itself", () => {
    const r = validateProposal(proposal({ fromAgent: "scout", toAgent: "scout" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /must differ/.test(e))).toBe(true);
  });

  it("rejects a free-text intent (must be a structural token)", () => {
    const r = validateProposal(proposal({ intent: "please review this when you can!" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /intent/.test(e))).toBe(true);
  });

  it("rejects an empty acceptanceCriteria list", () => {
    const r = validateProposal(proposal({ acceptanceCriteria: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /at least one criterion/.test(e))).toBe(true);
  });

  it("rejects a malformed artifactRef", () => {
    const r = validateProposal(proposal({ artifactRef: { type: "Blog Post", id: "" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => /artifactRef\.type/.test(e))).toBe(true);
      expect(r.errors.some((e) => /artifactRef\.id/.test(e))).toBe(true);
    }
  });

  it("collects every problem at once", () => {
    const r = validateProposal({ workspaceId: "", fromAgent: "bad handle", intent: "Nope!" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("HandoffService.propose (#584)", () => {
  it("persists a validated contract at status proposed with an initial history event", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    expect(h).toMatchObject({
      id: "h1",
      workspaceId: "ws1",
      fromAgent: "scout",
      toAgent: "quill",
      intent: "review",
      status: "proposed",
      artifactRef: { type: "blog_post", id: "launch-draft", uri: null },
    });
    expect(h.history).toEqual([{ at: h.createdAt, status: "proposed", actor: "scout", reason: null }]);
    expect(await svc.get("h1")).toMatchObject({ id: "h1", status: "proposed" });
  });

  it("throws HandoffValidationError and persists nothing for an invalid proposal", async () => {
    const svc = makeService();
    await expect(svc.propose(proposal({ acceptanceCriteria: [] }))).rejects.toBeInstanceOf(HandoffValidationError);
    expect(await svc.list()).toHaveLength(0);
  });
});

describe("HandoffService.accept — the validation gate (#584)", () => {
  it("lets the named recipient accept a valid, proposed handoff", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    const accepted = await svc.accept(h.id, "quill");
    expect(accepted.status).toBe("accepted");
    expect(accepted.history.map((e) => e.status)).toEqual(["proposed", "accepted"]);
    expect(accepted.history[1].actor).toBe("quill");
  });

  it("refuses acceptance by anyone other than the named recipient", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    await expect(svc.accept(h.id, "mark")).rejects.toBeInstanceOf(HandoffStateError);
    expect((await svc.get(h.id))!.status).toBe("proposed"); // unchanged
  });

  it("refuses to accept a record that does not validate against the schema", async () => {
    // Hand-craft an invalid record straight into the store (smuggled around propose), then prove accept
    // re-validates and refuses it — "an agent can only accept a handoff that validates."
    const store = new InMemoryHandoffStore();
    const svc = new HandoffService({ store, clock: fixedClock(), idGenerator: seqIds() });
    const bogus = {
      id: "bogus",
      workspaceId: "ws1",
      fromAgent: "scout",
      toAgent: "quill",
      artifactRef: { type: "blog_post", id: "x" },
      intent: "NOT A TOKEN!", // invalid
      acceptanceCriteria: [], // invalid
      status: "proposed",
      note: null,
      createdAt: "2026-06-22T00:00:00.000Z",
      updatedAt: "2026-06-22T00:00:00.000Z",
      history: [{ at: "2026-06-22T00:00:00.000Z", status: "proposed", actor: "scout", reason: null }],
    } as unknown as HandoffContract;
    await store.put(bogus);
    await expect(svc.accept("bogus", "quill")).rejects.toBeInstanceOf(HandoffValidationError);
    expect((await svc.get("bogus"))!.status).toBe("proposed"); // still not accepted
  });

  it("cannot accept a handoff twice (status guard)", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    await svc.accept(h.id, "quill");
    await expect(svc.accept(h.id, "quill")).rejects.toBeInstanceOf(HandoffStateError);
  });

  it("throws HandoffNotFoundError for an unknown id", async () => {
    const svc = makeService();
    await expect(svc.accept("nope", "quill")).rejects.toBeInstanceOf(HandoffNotFoundError);
  });

  it("serializes concurrent accepts so only one wins", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    const results = await Promise.allSettled([svc.accept(h.id, "quill"), svc.accept(h.id, "quill")]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("HandoffService lifecycle (#584)", () => {
  it("rejects a proposed handoff (recipient only) and records the reason", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    const rejected = await svc.reject(h.id, "quill", "out of scope\nfor me");
    expect(rejected.status).toBe("rejected");
    expect(rejected.history[1]).toMatchObject({ status: "rejected", actor: "quill", reason: "out of scope for me" });
  });

  it("completes only an accepted handoff, by the recipient", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    await expect(svc.complete(h.id, "quill")).rejects.toBeInstanceOf(HandoffStateError); // not yet accepted
    await svc.accept(h.id, "quill");
    const done = await svc.complete(h.id, "quill");
    expect(done.status).toBe("completed");
  });

  it("cancels a proposed handoff (proposer only)", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    await expect(svc.cancel(h.id, "quill")).rejects.toBeInstanceOf(HandoffStateError); // recipient can't cancel
    const cancelled = await svc.cancel(h.id, "scout");
    expect(cancelled.status).toBe("cancelled");
  });

  it("refuses any transition out of a terminal status", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    await svc.reject(h.id, "quill");
    await expect(svc.accept(h.id, "quill")).rejects.toBeInstanceOf(HandoffStateError);
    await expect(svc.cancel(h.id, "scout")).rejects.toBeInstanceOf(HandoffStateError);
  });
});

describe("no agent can act on an unstructured message (#584)", () => {
  it("always refuses a free-text handoff attempt", () => {
    const svc = makeService();
    expect(() => svc.refuseUnstructured("hey quill can you take the launch post?")).toThrow(UnstructuredHandoffError);
  });
});

describe("handoff log visibility (#584)", () => {
  it("lists every cross-agent handoff in creation order", async () => {
    const svc = makeService();
    await svc.propose(proposal({ toAgent: "quill" }));
    await svc.propose(proposal({ toAgent: "mark", intent: "publish" }));
    const log = await svc.list({ workspaceId: "ws1" });
    expect(log.map((h) => h.id)).toEqual(["h1", "h2"]);
  });

  it("filters by agent (from OR to) and by status", async () => {
    const svc = makeService();
    const h1 = await svc.propose(proposal({ toAgent: "quill" }));
    await svc.propose(proposal({ fromAgent: "mark", toAgent: "scout", intent: "implement" }));
    await svc.accept(h1.id, "quill");

    expect((await svc.list({ agent: "scout" })).map((h) => h.id)).toEqual(["h1", "h2"]); // scout is from on h1, to on h2
    expect((await svc.list({ agent: "mark" })).map((h) => h.id)).toEqual(["h2"]);
    expect((await svc.list({ status: "accepted" })).map((h) => h.id)).toEqual(["h1"]);
    expect((await svc.list({ status: "proposed" })).map((h) => h.id)).toEqual(["h2"]);
  });

  it("isolates handoffs per workspace", async () => {
    const svc = makeService();
    await svc.propose(proposal({ workspaceId: "ws1" }));
    await svc.propose(proposal({ workspaceId: "ws2" }));
    expect((await svc.list({ workspaceId: "ws1" })).map((h) => h.id)).toEqual(["h1"]);
    expect((await svc.list({ workspaceId: "ws2" })).map((h) => h.id)).toEqual(["h2"]);
  });
});

describe("validateContract (#584 full-record gate)", () => {
  it("accepts a service-produced contract", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    expect(validateContract(h).ok).toBe(true);
  });

  it("rejects a record with an unknown status", async () => {
    const svc = makeService();
    const h = await svc.propose(proposal());
    const r = validateContract({ ...h, status: "in_flight" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /status must be one of/.test(e))).toBe(true);
  });
});
