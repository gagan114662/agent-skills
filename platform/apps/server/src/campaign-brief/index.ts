/**
 * Central campaign brief (#588) — module barrel. Import everything from here.
 *
 * The rule this module makes enforceable: there is ONE editable campaign brief per workspace — ICP,
 * positioning, voice, goals, constraints, brand claims — and it is the single source of truth every
 * marketing agent reads at task start and cites in its plan. Edits propagate to in-flight planning because
 * the read is live. Typical use:
 *
 *   const svc = createDefaultCampaignBriefService();
 *   await svc.update(workspaceId, { positioning: "...", brandClaims: ["..."] }, ownerMemberId);  // owner edits
 *   const { task, revision } = await svc.enrichTask(workspaceId, rawTask);  // agent reads at task start
 *   // task now carries the DATA-framed brief block + the citation the agent echoes into its plan.
 *
 * Everything is sanitized as DATA (#200 FM#6) and grants no tools — editing a brief never widens scope
 * (#13). The module wires into no migration, schema barrel, or app-registry: its store is self-managed and
 * its only HTTP surface is two handlers added to the already-registered marketing route.
 */

export * from "./brief.js";
export * from "./store.js";
export * from "./service.js";
export { PgBriefStore, createDefaultCampaignBriefService } from "./default.js";
