/**
 * SEO content pipeline (issue #598) — the module barrel: import the pure core from here.
 *
 * The problem it solves: content production was ad hoc and a runaway session shipped junk because nothing forced
 * a piece through review. This module runs every piece through a staged pipeline with a gate at each step —
 * keyword (validated) → brief (complete) → draft (brand + fact check) → publish → index-ping — so a post can only
 * publish after passing every gate, and a junk draft is caught at the brand/fact gate. The contract:
 *
 *   1. Start a run:        const run = await svc.create({ workspaceId, topic });          // stage: "keyword"
 *   2. Advance each stage: run = await svc.advance(workspaceId, run.id);                  // keyword → brief → …
 *      A failing gate leaves the run `blocked` with reasons; fix the input and advance again (resumable).
 *   3. The two side-effecting stages REQUIRE an approval id from the #13 swipe-approve flow:
 *        await svc.advance(workspaceId, run.id, { approvalRequestId });                   // publish, then index_ping
 *
 * The guarantees are structural: each gate is fail-closed, `publish`/`index_ping` refuse without an approval id, a
 * disabled agent is an inert no-op, and the production providers are deterministic FAKES — so this change set
 * cannot make a live call or publish. Like the #597 community agent / #742 publisher, it touches no migration,
 * schema barrel, or app-wiring registry; `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgPipelineStore` / `createDefaultSeoContentPipelineService`) lives in `./default.js`
 * and is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure consumers (and
 * unit tests) can use the service, provider seams, and store interface against the in-memory store and FAKE
 * providers without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./gates.js";
export * from "./pipeline.js";
export * from "./providers.js";
export * from "./store.js";
export * from "./service.js";
