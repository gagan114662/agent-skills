/**
 * Community participation agent (issue #597) — the module barrel: import the pure core from here.
 *
 * The problem it solves: developer/founder communities (Reddit, Slack, Discord) are high-intent but unforgiving
 * of spam, and ipop has no safe way to participate. This module finds relevant threads, drafts genuinely helpful
 * value-first replies that mention ipop.ai only when relevant (always disclosing affiliation), gates every reply
 * through a fail-closed anti-spam guard, and routes every outbound post through the #13 approval queue. The
 * contract a participation agent follows:
 *
 *   1. Discover (dry run):  const cands = await svc.discover({ workspaceId, platform, communities });
 *                           // finds threads, drafts replies, runs the gate — persists/posts NOTHING.
 *   2. Queue the good ones: const rec = await svc.queue({ workspaceId, thread });
 *                           // re-runs the gate; a spammy reply is REFUSED and never queues. NOTHING posts.
 *   3. A human approves it through the #13 swipe-approve flow, yielding an approvalRequestId.
 *   4. Post on approval:    await svc.post(workspaceId, rec.id, { approvalRequestId });
 *                           // calls the provider once and records the external id.
 *
 * The guarantees are structural: `queue` is fail-closed on the anti-spam gate, `post` refuses without an approval
 * id, a disabled agent is an inert no-op, and the production provider is the deterministic sandbox — so this
 * change set cannot live-fetch or live-post. Like the #670 action-gate / #742 publisher, the change set touches
 * no migration, schema barrel, or app-wiring registry; `default.ts` self-manages its one Postgres table.
 *
 * The production binding (`PgParticipationStore` / `createDefaultCommunityParticipationService`) lives in
 * `./default.js` and is imported DIRECTLY by app wiring — it is intentionally NOT re-exported here so that pure
 * consumers (and unit tests) can use the service, provider seam, and store interface against the in-memory store
 * and sandbox provider without loading the Postgres driver.
 */

export * from "./types.js";
export * from "./caps.js";
export * from "./draft.js";
export * from "./gate.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
