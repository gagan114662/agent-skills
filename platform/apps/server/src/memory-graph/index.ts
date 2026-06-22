/**
 * Shared agent memory graph (issue #585) — the module barrel: import everything from here.
 *
 * The graph is the fleet's shared world model, scoped per workspace. The rule every agent follows is three
 * calls that bracket its work:
 *
 *   1. BEFORE acting on a subject — recall prior work so you don't redo it:
 *        const { hasPriorWork, priorWork } = await graph.recall(ws, { subject: "Acme Corp", kind: "prospect" });
 *        if (hasPriorWork) return priorWork; // surface the existing result instead of researching again (AC1)
 *
 *   2. BEFORE publishing a claim — flag contradictions with the shared graph:
 *        const conflicts = await graph.checkConflicts(ws, { kind: "claim", subject: "Acme Corp",
 *                                                            predicate: "pricing_model", value: "usage-based" });
 *        if (conflicts.length) flagForReview(summarizeConflicts(conflicts)); // don't ship the contradiction (AC2)
 *
 *   3. AFTER acting — write the fact/claim back (deduped) so the next agent sees it:
 *        await graph.record(ws, { kind: "research", subject: "growth loops", value: "…findings…", byAgent: "scout" });
 *
 * Nothing here is wired into a route or registry — like the sibling self-contained modules (#670/#674/#586),
 * the #585 change set touches no migration, schema barrel, or app-wiring file. A route layer can be added
 * later by importing `createDefaultMemoryGraphService` from `memory-graph/default.js` and exposing the
 * service methods.
 *
 * This barrel deliberately does NOT re-export the Postgres binding (`PgGraphStore` /
 * `createDefaultMemoryGraphService`): that lives in `./default.js` and pulls in the `pg` pool, so it is
 * imported only by the (future) route wiring. Keeping the barrel free of the DB dependency means any module
 * or test can import the graph's API + the in-memory store without standing up Postgres — mirroring how the
 * budget governor keeps its `default.ts` out of the import path of pure callers.
 */

export * from "./types.js";
export * from "./normalize.js";
export * from "./conflict.js";
export * from "./caps.js";
export {
  MemoryGraphService,
  MemoryGraphError,
  type MemoryGraphDeps,
  type RecordInput,
  type RecordResult,
  type RecallQuery,
  type RecallResult,
} from "./service.js";
export {
  InMemoryGraphStore,
  type GraphStore,
  type NodeQuery,
  type UpsertNodeInput,
  type UpsertNodeResult,
  type UpsertEdgeInput,
  type UpsertEdgeResult,
} from "./store.js";
