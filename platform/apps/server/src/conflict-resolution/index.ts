/**
 * Conflict-resolution arbiter (issue #587) — the module barrel: import everything from here.
 *
 * The problem it solves: when two or more agents propose competing strategies for the same objective, there is
 * no arbiter, so whichever ships last silently wins. The contract the orchestrator follows before shipping any
 * strategy:
 *
 *   1. Arbitrate the proposals:   const { resolution, record } = await svc.arbitrate({ workspaceId, proposals });
 *   2. Ship at most one:          const winner = shippableProposalId(record);
 *                                 if (winner) { …ship that proposal only… }     // merge or auto-pick
 *                                 else        { …escalated — DO NOT ship any… } // a human must decide first
 *   3. On escalation, a human decides ONE: await svc.decide(workspaceId, record.id, memberId, chosenProposalId);
 *                                 // now shippableProposalId(record) returns exactly that one proposal.
 *
 * The guarantee is structural: every objective yields at most ONE shippable proposal id, and zero while an
 * escalation is pending — competing proposals can never both ship (#587 acceptance). Like the #670 action-gate,
 * nothing here is configurable off, and the change set touches no migration, schema barrel, or app-wiring
 * registry — `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgConflictStore` / `createDefaultConflictResolutionService`) lives in `./default.js`
 * and is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and
 * unit tests) can use the decision core, store interface, and service against an in-memory store without loading
 * the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./detect.js";
export * from "./store.js";
export * from "./service.js";
