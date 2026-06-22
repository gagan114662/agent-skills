/**
 * A2A typed handoff contracts (#584) — module barrel. Import everything from here.
 *
 * The rule this module makes enforceable: a cross-agent handoff is a typed, validated, persisted record —
 * `{fromAgent, toAgent, artifactRef, intent, acceptanceCriteria, status}` — and an agent can only **accept**
 * a handoff that validates against the schema. Free text (`note`, rejection reasons) is metadata only,
 * never the payload an agent acts on. Typical use:
 *
 *   const svc = defaultHandoffService();
 *   const h = await svc.propose({ workspaceId, fromAgent: "scout", toAgent: "quill",
 *     artifactRef: { type: "blog_post", id: "launch-draft" }, intent: "review",
 *     acceptanceCriteria: ["no factual errors", "tone matches brand"] });   // throws if it doesn't validate
 *   await svc.accept(h.id, "quill");   // only "quill" can accept, and only if the record still validates
 *   await svc.list({ workspaceId });   // the handoff log — every cross-agent handoff, visible
 *
 * Nothing here does IO beyond its injected store, and it wires into no route/registry — it is a pure
 * library other modules call, which is why the #584 change set touches no migration, schema barrel, or
 * app-wiring file.
 */

export * from "./types.js";
export * from "./validate.js";
export * from "./store.js";
export * from "./service.js";
export { defaultHandoffService } from "./default.js";
