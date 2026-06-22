/**
 * Outbound-email channel + suppression/DNC + per-template approval (issue #594).
 *
 * A dedicated, self-contained module: it composes the existing deliverability (#268) and warmup/rate
 * caps (#268) helpers with this module's always-enforced suppression/DNC + consent gate and per-
 * template approval gate into a single channel decision ({@link evaluateOutboundEmail}). It performs
 * no IO and sends no mail — it returns a decision an executor acts on — and touches no DB migration,
 * schema barrel, or app-wiring registry.
 *
 * This is the module's public surface (a LOCAL barrel — not the global schema/exports barrel).
 */

export * from "./suppression.js";
export * from "./template-approval.js";
export * from "./channel.js";
