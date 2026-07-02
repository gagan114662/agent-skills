/**
 * Cross-industry award-transfer research lane (#1547, ADR-1547) — module barrel. Import from here.
 *
 * The capability this module makes real: a creative agent finds award-winning work from a COMPLETELY
 * UNRELATED industry, extracts the underlying MECHANISM, and transfers it to the client's category — the way
 * a creative director raids a reference archive. Four parts, mapped to the issue:
 *   1. Reference miner — a mechanism-indexed archive of real award cases ({@link AWARD_CASES}), enrichable
 *      via the SSRF-safe live miner ({@link LiveReferenceMiner}); the archive is keyed by MECHANISM, not
 *      industry, so distant categories sit side by side.
 *   2. Transfer step — {@link buildTerritoryBriefs}: retrieve 3–5 mechanisms from DISTANT industries
 *      (same/adjacent category rejected), each written up as mechanism → why it won → how it maps to this
 *      client → execution sketch per channel, anchored in a named source case.
 *   3. Feed the drafter — {@link renderTerritoryBriefsBlock} emits the DATA block the creative/Quill step
 *      consumes (wired into the #320 workspace-context preamble in `marketing/default.ts`).
 *   4. Approach, not execution — {@link screenDraftAgainstCases} is Lens's screen that rejects a draft which
 *      copied the source's literal execution instead of transferring the abstract mechanism.
 *
 * Typical use:
 *   const svc = createAwardTransferService();
 *   const briefs = svc.territoryBriefsForClient({ category: "tech-software", product: "ipop.ai", ... });
 *   const block = svc.territoryBriefsBlock({ ... });   // → prepended to a briefed drafting task as DATA
 *   const screen = svc.screenDraft(draft, briefs);     // → Lens rejects if screen.derivative
 *
 * Everything is pure DATA (#200 FM#6), performs no send/spend, and grants no tools — producing a territory
 * brief never widens an agent's scope (#13 holds every real action). Default-OFF, owner-workspace-first.
 */

export * from "./mechanism.js";
export * from "./corpus.js";
export * from "./transfer.js";
export * from "./derivative.js";
export * from "./provider.js";
export * from "./service.js";
