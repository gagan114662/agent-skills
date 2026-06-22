/**
 * Unit tests for the dependency-scheduler service (issue #590). Exercises the injected store + clock seams: the
 * default-OFF execution switch, atomic claiming, gate transitions, the structural `assertRunnable` guard, and
 * lazy/deterministic behaviour with a fixed clock (no real time).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  DependencySchedulerService,
  DependencySchedulerError,
} from "../../src/dependency-scheduler/service.js";
import { InMemoryDependencySchedulerStore } from "../../src/dependency-scheduler/store.js";
import { DEPENDENCY_SCHEDULER_DEFAULTS, type DependencySchedulerCaps } from "../../src/dependency-scheduler/caps.js";

const WS = "ws-1";
const ENABLED: DependencySchedulerCaps = { ...DEPENDENCY_SCHEDULER_DEFAULTS, enabled: true };

/** A deterministic clock that advances 1s per read so updatedAt timestamps are stable and ordered. */
function fixedClock(startMs = 1_700_000_000_000): () => Date {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

function makeService(caps: DependencySchedulerCaps = ENABLED) {
  const store = new InMemoryDependencySchedulerStore();
  const svc = new DependencySchedulerService({ store, caps, now: fixedClock() });
  return { store, svc };
}

describe("DependencySchedulerService (#590)", () => {
  let svc: DependencySchedulerService;
  beforeEach(() => {
    ({ svc } = makeService());
  });

  it("schedule records a task with its visible dependency list and defaults", async () => {
    const draft = await svc.schedule({ workspaceId: WS, kind: "draft" });
    const publish = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [draft.id], label: "go live" });
    expect(draft.status).toBe("pending");
    expect(publish.dependsOn).toEqual([draft.id]);
    expect(publish.label).toBe("go live");
  });

  it("DEFAULT OFF: when disabled, claimNext hands out nothing (so nothing executes)", async () => {
    const { svc: off } = makeService({ ...DEPENDENCY_SCHEDULER_DEFAULTS, enabled: false });
    await off.schedule({ workspaceId: WS, kind: "draft" });
    expect(await off.claimNext(WS)).toBeNull();
    // ...but planning still works for visibility.
    const plan = await off.plan(WS);
    expect(plan.runnable).toHaveLength(1);
  });

  it("claimNext atomically claims the next runnable task (pending → running) and hands it out once", async () => {
    await svc.schedule({ workspaceId: WS, kind: "draft" });
    const first = await svc.claimNext(WS);
    expect(first?.status).toBe("running");
    // The same task is not handed out again (it is now running, not pending).
    expect(await svc.claimNext(WS)).toBeNull();
  });

  it("END-TO-END: an outbound task is never claimable until its content gate is approved", async () => {
    const draft = await svc.schedule({ workspaceId: WS, kind: "draft" });
    const review = await svc.schedule({ workspaceId: WS, kind: "review", dependsOn: [draft.id] });
    const publish = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [review.id] });

    // 1) Only the draft is claimable.
    const c1 = await svc.claimNext(WS);
    expect(c1?.id).toBe(draft.id);
    await svc.complete(WS, draft.id);

    // 2) Now the review gate is claimable; publish still is NOT.
    const c2 = await svc.claimNext(WS);
    expect(c2?.id).toBe(review.id);
    await expect(svc.assertRunnable(WS, publish.id)).rejects.toThrow(DependencySchedulerError);
    expect(await svc.claimNext(WS)).toBeNull(); // review is running, publish gated

    // 3) Approving the gate is what unblocks distribution.
    await svc.approve(WS, review.id);
    // Before claiming, the structural guard now clears publish (its gate is approved).
    await expect(svc.assertRunnable(WS, publish.id)).resolves.toMatchObject({ id: publish.id });
    const c3 = await svc.claimNext(WS);
    expect(c3?.id).toBe(publish.id);
    // Once claimed (running), it is no longer "runnable" — the guard is a pre-execution check.
    await expect(svc.assertRunnable(WS, publish.id)).rejects.toThrow(DependencySchedulerError);
  });

  it("rejecting the gate permanently blocks the outbound task", async () => {
    const review = await svc.schedule({ workspaceId: WS, kind: "review" });
    const publish = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [review.id] });
    await svc.claimNext(WS); // claims review
    await svc.reject(WS, review.id);
    expect(await svc.claimNext(WS)).toBeNull();
    const plan = await svc.plan(WS);
    expect(plan.blocked.find((b) => b.taskId === publish.id)?.reason).toBe("upstream_failed");
  });

  it("assertRunnable throws for a gated outbound task and resolves once cleared", async () => {
    const review = await svc.schedule({ workspaceId: WS, kind: "approval" });
    const send = await svc.schedule({ workspaceId: WS, kind: "send", dependsOn: [review.id] });
    await expect(svc.assertRunnable(WS, send.id)).rejects.toThrow(/not runnable/);
    await svc.claimNext(WS); // claim review
    await svc.approve(WS, review.id);
    await expect(svc.assertRunnable(WS, send.id)).resolves.toMatchObject({ id: send.id });
  });

  it("transition guards reject out-of-state moves", async () => {
    const draft = await svc.schedule({ workspaceId: WS, kind: "draft" });
    // Cannot complete a task that is still pending (must be claimed/running first).
    await expect(svc.complete(WS, draft.id)).rejects.toThrow(/expected running/);
    await svc.claimNext(WS);
    await svc.complete(WS, draft.id);
    // Cannot complete twice.
    await expect(svc.complete(WS, draft.id)).rejects.toThrow(DependencySchedulerError);
  });

  it("cancel works on pending or running tasks and blocks dependents", async () => {
    const draft = await svc.schedule({ workspaceId: WS, kind: "draft" });
    const publishGate = await svc.schedule({ workspaceId: WS, kind: "review", dependsOn: [draft.id] });
    const cancelled = await svc.cancel(WS, draft.id);
    expect(cancelled.status).toBe("cancelled");
    const plan = await svc.plan(WS);
    expect(plan.blocked.find((b) => b.taskId === publishGate.id)?.reason).toBe("upstream_failed");
  });

  it("workspace scoping: a task cannot be claimed or read from another workspace", async () => {
    await svc.schedule({ workspaceId: WS, kind: "draft" });
    expect(await svc.claimNext("other-ws")).toBeNull();
    const draft = (await svc.list(WS))[0]!;
    expect(await svc.get("other-ws", draft.id)).toBeNull();
  });

  it("plan can be scoped to a single objective", async () => {
    await svc.schedule({ workspaceId: WS, kind: "draft", objectiveId: "obj-a" });
    await svc.schedule({ workspaceId: WS, kind: "draft", objectiveId: "obj-b" });
    const planA = await svc.plan(WS, "obj-a");
    expect(planA.runnable).toHaveLength(1);
  });
});
