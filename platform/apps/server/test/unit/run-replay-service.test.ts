import { describe, it, expect, beforeEach } from "vitest";
import { RunReplayService, RunReplayError } from "../../src/run-replay/service.js";
import { InMemoryRunReplayStore } from "../../src/run-replay/store.js";
import type { RunReplayCaps } from "../../src/run-replay/caps.js";
import type { RunOutcome } from "../../src/run-replay/types.js";

const ENABLED: RunReplayCaps = { enabled: true, maxInputBytes: 256 * 1024 };

/** A controllable epoch-ms clock. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function makeService(opts: { caps?: RunReplayCaps; now: () => number; seed?: number; secretValues?: string[] }) {
  const store = new InMemoryRunReplayStore();
  const service = new RunReplayService({
    store,
    caps: opts.caps ?? ENABLED,
    now: opts.now,
    genSeed: () => opts.seed ?? 99,
    secretValues: opts.secretValues,
  });
  return { store, service };
}

const FAILURE: RunOutcome = { status: "failed", failureSignature: "boom", outputFingerprint: "o-fail" };
const SUCCESS: RunOutcome = { status: "completed", failureSignature: null, outputFingerprint: "o-ok" };

describe("RunReplayService.capture", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("captures a run's inputs, minting a seed when none is supplied", async () => {
    const { service } = makeService({ now: c.now, seed: 1234 });
    const cap = await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "do it", config: { model: "m" } });
    expect(cap).not.toBeNull();
    expect(cap!.status).toBe("running");
    expect(cap!.inputs.seed).toBe(1234);
    expect(cap!.inputs.prompt).toBe("do it");
    expect(cap!.capturedAtMs).toBe(c.now());
    expect(cap!.inputsFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honors an explicit seed (the run already chose one)", async () => {
    const { service } = makeService({ now: c.now, seed: 1234 });
    const cap = await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p", seed: 7 });
    expect(cap!.inputs.seed).toBe(7);
  });

  it("is an inert no-op when the feature is disabled", async () => {
    const { service, store } = makeService({ now: c.now, caps: { ...ENABLED, enabled: false } });
    expect(await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p" })).toBeNull();
    expect(await store.getByRunId("r1")).toBeNull();
  });

  it("rejects a capture whose redacted inputs exceed the byte cap", async () => {
    const { service } = makeService({ now: c.now, caps: { enabled: true, maxInputBytes: 64 } });
    await expect(
      service.capture({ runId: "r1", workspaceId: "ws1", prompt: "x".repeat(500) }),
    ).rejects.toBeInstanceOf(RunReplayError);
  });

  it("scrubs known secret values from the captured prompt", async () => {
    const { service } = makeService({ now: c.now, seed: 1, secretValues: ["sk-live-9"] });
    const cap = await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "key is sk-live-9 ok" });
    expect(cap!.inputs.prompt).not.toContain("sk-live-9");
  });
});

describe("RunReplayService outcome + reads", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("stamps a terminal outcome and flips status", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p" });
    c.advance(500);
    const done = await service.recordOutcome("r1", FAILURE);
    expect(done!.status).toBe("failed");
    expect(done!.outcome).toEqual(FAILURE);
    expect(done!.endedAtMs).toBe(c.now());
  });

  it("recordOutcome is a no-op for an uncaptured run", async () => {
    const { service } = makeService({ now: c.now });
    expect(await service.recordOutcome("ghost", FAILURE)).toBeNull();
  });

  it("scopes reads to the owning workspace (IDOR boundary)", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p" });
    expect(await service.getCapture("ws1", "r1")).not.toBeNull();
    expect(await service.getCapture("ws2", "r1")).toBeNull();
    expect(await service.listCaptures("ws2")).toHaveLength(0);
  });
});

describe("RunReplayService.prepareReplay", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("returns the plan to reproduce a failed run", async () => {
    const { service } = makeService({ now: c.now, seed: 7 });
    await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p", config: { model: "m" } });
    await service.recordOutcome("r1", FAILURE);

    const plan = await service.prepareReplay("ws1", "r1");
    expect(plan.originalRunId).toBe("r1");
    expect(plan.inputs.seed).toBe(7);
    expect(plan.inputs.prompt).toBe("p");
    expect(plan.expectedOutcome).toEqual(FAILURE);
  });

  it("throws for a run with no capture in this workspace (IDOR + missing)", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p" });
    await service.recordOutcome("r1", FAILURE);
    await expect(service.prepareReplay("ws2", "r1")).rejects.toBeInstanceOf(RunReplayError);
    await expect(service.prepareReplay("ws1", "ghost")).rejects.toBeInstanceOf(RunReplayError);
  });

  it("throws for a run that did not fail (only failures are reproduced)", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "r1", workspaceId: "ws1", prompt: "p" });
    await service.recordOutcome("r1", SUCCESS);
    await expect(service.prepareReplay("ws1", "r1")).rejects.toThrow(/did not fail/);
  });
});

describe("RunReplayService reproduce flow (capture → fail → replay → verify)", () => {
  let c: ReturnType<typeof clock>;
  beforeEach(() => {
    c = clock();
  });

  it("confirms a reproduction when the replay fails the same way", async () => {
    const { service } = makeService({ now: c.now, seed: 7 });
    // original failed run
    await service.capture({ runId: "orig", workspaceId: "ws1", prompt: "p", config: { model: "m" } });
    await service.recordOutcome("orig", FAILURE);

    // integrator re-executes from the plan's inputs, captured as a replay
    const plan = await service.prepareReplay("ws1", "orig");
    await service.capture({
      runId: "rep",
      workspaceId: "ws1",
      prompt: plan.inputs.prompt,
      seed: plan.inputs.seed,
      config: plan.inputs.config,
      env: plan.inputs.env,
      replayOf: "orig",
    });
    await service.recordOutcome("rep", { ...FAILURE });

    const verdict = await service.verifyReplay("ws1", "orig", "rep");
    expect(verdict.reproduced).toBe(true);
    expect(verdict.kind).toBe("reproduced");

    // the replay is linked back to the original
    const replays = await service.listReplays("ws1", "orig");
    expect(replays.map((r) => r.runId)).toEqual(["rep"]);
  });

  it("reports divergence when the replay no longer fails", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "orig", workspaceId: "ws1", prompt: "p" });
    await service.recordOutcome("orig", FAILURE);
    await service.capture({ runId: "rep", workspaceId: "ws1", prompt: "p", replayOf: "orig" });
    await service.recordOutcome("rep", SUCCESS);

    const verdict = await service.verifyReplay("ws1", "orig", "rep");
    expect(verdict.reproduced).toBe(false);
    expect(verdict.kind).toBe("diverged");
  });

  it("verifyReplay throws when either run lacks a recorded outcome", async () => {
    const { service } = makeService({ now: c.now });
    await service.capture({ runId: "orig", workspaceId: "ws1", prompt: "p" });
    await service.recordOutcome("orig", FAILURE);
    await service.capture({ runId: "rep", workspaceId: "ws1", prompt: "p", replayOf: "orig" });
    // rep has no outcome yet
    await expect(service.verifyReplay("ws1", "orig", "rep")).rejects.toBeInstanceOf(RunReplayError);
  });
});
