/**
 * Short-form video generation agent (#740) — module barrel. Import everything from here.
 *
 * The capability this module adds: an agent that reads the workspace's live campaign brief (#588 — ICP,
 * positioning, voice, approved claims) and turns a topic into a ready-to-shoot vertical short-form video — a
 * deterministic, brief-grounded script + storyboard plus a rendered asset. Typical use:
 *
 *   const svc = createDefaultShortFormVideoService();   // OFF until SHORTFORM_VIDEO_ENABLED=1
 *   const result = await svc.generate({
 *     workspaceId, requestedByMemberId,
 *     topic: "Why founders waste 10 hours a week on marketing",
 *     brief: { audience, positioning, voice, brandClaims },   // adapted from the live #588 brief
 *   });
 *   // result.status: "disabled" | "missing_brief" | "script_only" | "rendered"
 *
 * Self-contained + parallel-merge safe like #588/#670/#674: env-only config (default OFF), a self-managed
 * Postgres table created lazily on first use, and a deterministic offline FAKE provider so NO external call
 * happens until a real renderer is wired in a later change. It touches no migration, no schema barrel, no
 * app-wiring registry, and no web UI. Everything is DATA (#200 FM#6) and grants no tools — producing a draft
 * video never widens scope; any outbound publish stays behind the existing approval gate (#13).
 */

export * from "./types.js";
export * from "./config.js";
export * from "./script.js";
export * from "./provider.js";
export * from "./store.js";
export * from "./service.js";
export { PgVideoJobStore, createDefaultShortFormVideoService } from "./default.js";
