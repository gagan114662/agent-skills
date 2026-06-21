/**
 * The pure gating decisions for the execution-tool framework (#464). No IO — the service supplies the tool
 * spec + the resolved amount; these decide the human-approval boundary and confirm the tool maps to a real,
 * recognized #13 gated action (no orphan authority).
 *
 * The framework is deliberately CONSERVATIVE and matches the structural always-gate pattern the outward
 * services already use (`social`/`hosted`/`outreach` "ALWAYS park; there is no auto-approve branch"): every
 * execution boundary — public, outbound, or money — pauses for an explicit human. {@link
 * classifyExecutionBoundary} therefore always returns `gate: true`; it exists to NAME the boundary (and the
 * exact spend) for the owner, never to hand back an autonomous outcome.
 */
import {
  HOSTED_PUBLISH_ACTION,
  REALWORLD_PUBLISH_ACTION,
  SOCIAL_PUBLISH_POST_ACTION,
  OUTREACH_SEND_ACTION,
  EMAIL_LIVE_SEND_ACTION,
  SEARCH_CONSOLE_SUBMIT_ACTION,
  VENTURE_AD_SPEND_ACTION,
  PROVISIONING_CUSTOMER_SPEND_ACTION,
} from "../approvals/policy.js";
import type { ExecutionToolSpec, ToolVisibility } from "./types.js";

/**
 * The allow-list of #13 action types an execution tool may park (permission: a tool can only reach an
 * action the approval taxonomy already gates). Every entry is an OUTWARD or MONEY action — publishing,
 * posting, sending, submitting, or spending — that is human-gated downstream. A tool referencing anything
 * outside this set is a wiring bug the registry test catches before it can ever park.
 */
const EXECUTION_GATED_ACTIONS: ReadonlySet<string> = new Set([
  HOSTED_PUBLISH_ACTION, // publish a customer page live (#266)
  REALWORLD_PUBLISH_ACTION, // publish a page to a public URL (#231)
  SOCIAL_PUBLISH_POST_ACTION, // fan a post out to connected networks (#269)
  OUTREACH_SEND_ACTION, // send a 1:1 message to a real prospect (#225)
  EMAIL_LIVE_SEND_ACTION, // send a live email (#268)
  SEARCH_CONSOLE_SUBMIT_ACTION, // submit a sitemap / request indexing (#265)
  VENTURE_AD_SPEND_ACTION, // commit paid acquisition spend (#187)
  PROVISIONING_CUSTOMER_SPEND_ACTION, // release the customer's own budget / email tier (#267)
]);

/** True iff `actionType` is an outward/money action an execution tool is allowed to park. Pure + total. */
export function isGatedAction(actionType: string): boolean {
  return EXECUTION_GATED_ACTIONS.has(actionType);
}

/** The classified boundary: which kind of human-approval line the action crosses, and why it gates. */
export interface ExecutionBoundary {
  boundary: ToolVisibility;
  /** Always `true` — there is no autonomous execution path. */
  gate: true;
  /** The human-readable reason the owner sees (names the spend for a money boundary). */
  reason: string;
}

/**
 * Classify the human-approval boundary for invoking `tool` with a resolved `amount`. A money tool (or any
 * tool that arrived with a positive spend) crosses the MONEY boundary and the reason names the exact amount;
 * a `public` tool crosses the public-surface boundary; an `outbound` tool crosses the outbound boundary.
 * Every case gates — the framework has no un-gated outcome. Pure + total.
 */
export function classifyExecutionBoundary(tool: ExecutionToolSpec, amount: number | null): ExecutionBoundary {
  const spends = typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  if (tool.visibility === "money" || spends) {
    const figure = typeof amount === "number" && Number.isFinite(amount) ? String(amount) : "an amount";
    return {
      boundary: "money",
      gate: true,
      reason: `commits real spend (${figure}) — owner approval required before any money moves`,
    };
  }
  if (tool.visibility === "public") {
    return {
      boundary: "public",
      gate: true,
      reason: "publishes a publicly visible surface — owner approval required before it goes live",
    };
  }
  return {
    boundary: "outbound",
    gate: true,
    reason: "sends outside the workspace — owner approval required before it leaves the building",
  };
}
