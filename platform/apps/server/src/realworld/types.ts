/**
 * The real-world tool surface (#231). Pure data shapes describing the bounded, enumerated set of
 * REAL-WORLD actions a venture's fleet can take — publish a live page, send email, post to social,
 * browse/research the web, handle assets, call external APIs. No IO here.
 *
 * Two safety properties are encoded structurally, not by convention:
 *
 *  1. **#200 gating** — every tool carries its `reversibility` and a `requiresApproval` flag. Every
 *     OUTWARD or IRREVERSIBLE tool (a send is deliverability/brand, an API call may move money) is
 *     `requiresApproval: true` and routes through the #13 human-approval gate. `tools.ts` is the single
 *     source of truth and throws on an unknown name, so a new tool can never silently bypass the gate.
 *
 *  2. **#223 injection-quarantine** — every tool is classed by `dataFlow`: `read` tools (browse,
 *     research) return DATA only; `actuate` tools change the world. The read surface and the actuator
 *     surface are split into two services with DISJOINT dependency sets (see `service.ts`), so a
 *     poisoned web read has no actuator to reach — exactly the #223 decision-maker defense.
 */

import type { ServiceKind } from "../onboarding/types.js";

/** The closed real-world tool vocabulary. Stable + bounded (part of the audit/receipt surface). */
export const REAL_WORLD_TOOL_NAMES = [
  "publish",
  "send_email",
  "post_social",
  "browse",
  "research",
  "store_asset",
  "call_api",
] as const;

export type RealWorldToolName = (typeof REAL_WORLD_TOOL_NAMES)[number];

/**
 * Reversibility class (#200 failure-mode 4). `irreversible` = deliverability/brand/money — a sent email
 * cannot be unsent, an external API call may move money. `reversible` work (a published page can be
 * redeployed or taken down, an asset re-stored) is still gated when it is OUTWARD/public, but is not
 * counted toward the irreversible-exposure window.
 */
export type ToolReversibility = "reversible" | "irreversible";

/**
 * The #223 quarantine class. `read` tools fetch external content and return DATA only — they live in a
 * service with no actuator capability, so injected instructions in fetched text cannot cause a send.
 * `actuate` tools change the world (publish/send/post/store/call) and are the only ones that can.
 */
export type ToolDataFlow = "read" | "actuate";

/** One tool's metadata: the load-bearing classification consumed by `decide.ts`, the service, and tests. */
export interface RealWorldToolSpec {
  name: RealWorldToolName;
  reversibility: ToolReversibility;
  dataFlow: ToolDataFlow;
  /**
   * True iff invoking the tool is outward/irreversible and therefore ALWAYS requires a #13 approval
   * (recorded-only until a human approves). Read-only tools are never gated.
   */
  requiresApproval: boolean;
  /**
   * The venture-operating external accounts (#192 `ServiceKind`) the tool acts THROUGH. The tool cannot
   * run until every one of these is connected — this is what makes the readiness signal honest: "you
   * must connect a hosting account before the fleet can publish".
   */
  requiredAccounts: readonly ServiceKind[];
  /** A one-line description (the human-readable receipt + the tool-surface doc). */
  description: string;
}

/** What the gate needs to know to decide a tool: which external accounts the workspace has connected. */
export interface ToolGateContext {
  connectedAccounts: ReadonlySet<ServiceKind>;
}

/** The pure gate decision for one tool in a workspace's current connection state. */
export interface ToolGateDecision {
  tool: RealWorldToolName;
  reversibility: ToolReversibility;
  dataFlow: ToolDataFlow;
  /** True iff every required account is connected — the tool CAN run (subject to approval). */
  allowed: boolean;
  /** True iff a #13 approval is required before the action takes effect. */
  requiresApproval: boolean;
  /** Required accounts not yet connected (empty ⇒ ready). */
  missingAccounts: ServiceKind[];
  /** One-line human reason for the decision (queue/console copy). */
  reason: string;
}
