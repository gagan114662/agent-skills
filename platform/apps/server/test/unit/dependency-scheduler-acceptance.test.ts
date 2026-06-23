/**
 * Acceptance tests for issue #590, stated directly against the criteria:
 *   1. "no outbound action executes while its upstream gate is unmet"
 *   2. "the dependency is visible on the task"
 *
 * These assert the END-TO-END guarantee through the service over the in-memory store, the way the orchestrator
 * uses it: the ONLY way to execute is `claimNext`, and an outbound task is never claimable until its content gate
 * is approved — across a realistic multi-hop draft → review → brand_check → publish chain.
 */

import { describe, it, expect } from "vitest";
import { DependencySchedulerService } from "../../src/dependency-scheduler/service.js";
import { InMemoryDependencySchedulerStore } from "../../src/dependency-scheduler/store.js";
import { DEPENDENCY_SCHEDULER_DEFAULTS } from "../../src/dependency-scheduler/caps.js";

const WS = "ws-acc";

function service() {
  let n = 0;
  const store = new InMemoryDependencySchedulerStore();
  return new DependencySchedulerService({
    store,
    caps: { ...DEPENDENCY_SCHEDULER_DEFAULTS, enabled: true },
    now: () => new Date(1_700_000_000_000 + n++ * 1000),
  });
}

/** Drain every currently-runnable task, recording the order in which work was actually handed out to execute. */
async function drain(
  svc: DependencySchedulerService,
  advance: (id: string, kind: string) => Promise<void>,
): Promise<string[]> {
  const order: string[] = [];
  for (let guard = 0; guard < 100; guard++) {
    const next = await svc.claimNext(WS);
    if (!next) break;
    order.push(next.id);
    await advance(next.id, next.kind);
  }
  return order;
}

describe("#590 acceptance — outbound never runs before its upstream gate", () => {
  it("a draft → review → brand_check → publish chain executes strictly in gated order", async () => {
    const svc = service();
    const draft = await svc.schedule({ workspaceId: WS, kind: "draft", label: "blog post" });
    const review = await svc.schedule({ workspaceId: WS, kind: "review", dependsOn: [draft.id] });
    const brand = await svc.schedule({ workspaceId: WS, kind: "brand_check", dependsOn: [review.id] });
    const publish = await svc.schedule({
      workspaceId: WS,
      kind: "publish",
      dependsOn: [brand.id],
      label: "publish to blog",
    });

    // Criterion 2: the dependency is visible on the task.
    expect(publish.dependsOn).toEqual([brand.id]);

    const executed: string[] = [];
    const order = await drain(svc, async (id, kind) => {
      executed.push(id);
      // Gates get approved; ordinary work completes. (All gate kinds resolve via approve.)
      if (kind === "review" || kind === "brand_check" || kind === "approval") await svc.approve(WS, id);
      else await svc.complete(WS, id);
    });

    // Criterion 1: publish only ever executed AFTER both gates, and the chain ran in dependency order.
    expect(order).toEqual([draft.id, review.id, brand.id, publish.id]);
    expect(executed.indexOf(publish.id)).toBeGreaterThan(executed.indexOf(review.id));
    expect(executed.indexOf(publish.id)).toBeGreaterThan(executed.indexOf(brand.id));
  });

  it("if a gate is rejected, the outbound action never executes at all", async () => {
    const svc = service();
    const review = await svc.schedule({ workspaceId: WS, kind: "review" });
    const publish = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [review.id] });

    const executed: string[] = [];
    await drain(svc, async (id, kind) => {
      executed.push(id);
      if (kind === "review") await svc.reject(WS, id); // content fails review
      else await svc.complete(WS, id);
    });

    expect(executed).toEqual([review.id]); // publish never handed out
    const plan = await svc.plan(WS);
    expect(plan.runnable).not.toContain(publish.id);
    expect(plan.blocked.find((b) => b.taskId === publish.id)?.permanent).toBe(true);
  });

  it("two independent content chains do not let one's publish jump the other's ungated gate", async () => {
    const svc = service();
    // Chain A is fully approved; chain B's gate is never approved.
    const draftA = await svc.schedule({ workspaceId: WS, kind: "draft", objectiveId: "A" });
    const reviewA = await svc.schedule({ workspaceId: WS, kind: "review", dependsOn: [draftA.id], objectiveId: "A" });
    const pubA = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [reviewA.id], objectiveId: "A" });
    const reviewB = await svc.schedule({ workspaceId: WS, kind: "review", objectiveId: "B" });
    const pubB = await svc.schedule({ workspaceId: WS, kind: "publish", dependsOn: [reviewB.id], objectiveId: "B" });

    const executed: string[] = [];
    await drain(svc, async (id, kind) => {
      executed.push(id);
      // Approve everything EXCEPT chain B's review (leave it running/unapproved by failing it).
      if (id === reviewB.id) await svc.reject(WS, id);
      else if (kind === "review") await svc.approve(WS, id);
      else await svc.complete(WS, id);
    });

    expect(executed).toContain(pubA.id); // A's publish cleared its gate
    expect(executed).not.toContain(pubB.id); // B's publish never cleared its gate
  });
});
