/**
 * Dependency-aware scheduler (issue #590) — the module barrel: import everything from here.
 *
 * The problem it solves: distribution agents (publish / send / post) can fire before the content they distribute
 * has passed review / brand-check / approval, risking junk going public. The contract the orchestrator follows:
 *
 *   1. Declare the chain with visible dependencies:
 *        const draft  = await svc.schedule({ workspaceId, kind: "draft" });
 *        const review = await svc.schedule({ workspaceId, kind: "review",  dependsOn: [draft.id] });
 *        const post   = await svc.schedule({ workspaceId, kind: "publish", dependsOn: [review.id] });
 *   2. Only ever execute what the scheduler hands out:
 *        const next = await svc.claimNext(workspaceId);   // returns `draft` first; `post` only after `review` is approved
 *   3. Advance gates explicitly — approval is what unblocks distribution:
 *        await svc.approve(workspaceId, review.id);        // now `post` becomes claimable
 *   4. Before any outbound actuator call, assert eligibility structurally:
 *        await svc.assertRunnable(workspaceId, post.id);   // throws if the gate is not yet approved
 *
 * The guarantee is structural: an outbound task is planner-runnable only once its content gate is `approved`, so
 * no outbound action runs while its upstream gate is unmet (#590 acceptance). Like the #670 action-gate, the
 * change set touches no migration, schema barrel, or app-wiring registry — `default.ts` self-manages its one
 * Postgres table — and it ships **default OFF** (`DEP_SCHEDULER_ENABLED`).
 *
 * The production binding (`PgDependencySchedulerStore` / `createDefaultDependencySchedulerService`) lives in
 * `./default.js` and is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure
 * consumers (and unit tests) can use the planner, store interface, and service against an in-memory store without
 * loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./plan.js";
export * from "./store.js";
export * from "./service.js";
