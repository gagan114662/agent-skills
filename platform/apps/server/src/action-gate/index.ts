/**
 * Action-gate (issue #670) — the confirm-gate for PUBLIC / IRREVERSIBLE actions. This is the module barrel:
 * import everything from here. The contract any actuator follows before it publishes / sends / posts / deletes:
 *
 *   1. Guard before acting:                   const g = await gate.guardAction({ workspaceId, requesterMemberId, action });
 *      if (g.allowed) { …run the action… }     // internal + reversible → autonomous
 *      else           { return g.request; }     // parked for human approval — DO NOT execute
 *   2. A human decides on the queue:          await gate.approve(workspaceId, g.request.id, ownerMemberId);
 *   3. Retry consumes the recorded approval:  const ok = await gate.consumeApproval({ workspaceId, requestId: g.request.id, requesterMemberId, action });
 *                                              // throws unless an approved, unexpired, fingerprint-matching
 *                                              // approval exists; only after it returns may the action run.
 *
 * The guarantee is structural: a public/irreversible/uncertain action has no path to execution except through a
 * recorded, human approval bound to that exact action (#200 §4 — approval is per-action, never a blanket grant).
 * Like the #674 content-guard, nothing here is configurable off, and the change set touches no migration, schema
 * barrel, or app-wiring registry — `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgGateRequestStore` / `createDefaultActionGateService`) lives in `./default.js` and is
 * imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and unit
 * tests) can use the classifier, store interface, and service against an in-memory store without loading the
 * Postgres driver.
 */

export * from "./classify.js";
export * from "./caps.js";
export * from "./store.js";
export * from "./service.js";
