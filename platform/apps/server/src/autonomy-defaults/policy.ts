/**
 * The pure autonomy-by-default policy (issue #727). This is the single source of truth for the product promise:
 * a fresh or existing workspace has ALL agent capabilities ON out of the box and produces work with zero
 * switch-flipping; the ONLY hard, code-enforced approval gate is money/spend.
 *
 *   decideAutonomy(action, caps) →
 *     • money action            → { mode: "gated", gate: "money" }            // non-toggleable hard gate
 *     • capability dialed OFF    → { mode: "gated", gate: "capability_disabled" }
 *     • channel dialed OFF       → { mode: "gated", gate: "channel_disabled" }
 *     • everything else          → { mode: "autonomous", gate: "none" }       // the default
 *
 * The opt-OUT toggles in `caps.ts` default ON, so dialing one off is a deliberate user choice that can only ever
 * ADD gating to a single capability/channel — it can never relax the money gate (no path exists). Three guards
 * stay ALWAYS ON and are NOT part of this policy's toggle set (a caller runs them independently of this decision):
 * the kill-switch (#592), suppression / opt-out / DNC (#594), and anti-injection (#674). {@link ALWAYS_ON_GUARDS}
 * names them so the invariant is testable.
 *
 * Pure + total: no IO, no clock, no randomness.
 */

import { type AutonomyCaps, type Capability, type Channel } from "./defaults.js";
import { classifyMoney, type MoneyActionDescriptor, type MoneyClassification } from "./money.js";

/**
 * The guards that are ALWAYS ON and never part of the opt-out toggle set — they run independently of, and are
 * never weakened by, the autonomy decision. Named here so the "always on" invariant is asserted in tests.
 */
export const ALWAYS_ON_GUARDS = ["kill_switch", "suppression_opt_out", "anti_injection"] as const;
export type AlwaysOnGuard = (typeof ALWAYS_ON_GUARDS)[number];

/** A proposed action to rule on — the money descriptor plus the (optional) capability/channel it acts through. */
export interface AutonomyActionDescriptor extends MoneyActionDescriptor {
  /** The capability this action belongs to. Omit to let the verb decide (inferred from the action token). */
  capability?: Capability;
  /** The outreach channel this action uses (e.g. `email`). Omit when the action is not channel-scoped. */
  channel?: Channel;
  /** A short human summary for the review queue (e.g. "Charge card $42"). Audit only — does not steer the verdict. */
  summary?: string | null;
}

export type AutonomyMode = "autonomous" | "gated";
export type AutonomyGate = "money" | "capability_disabled" | "channel_disabled" | "none";

/** The policy's verdict on a single proposed action. Pure data. */
export interface AutonomyDecision {
  /** THE answer: does this action run on its own, or pause for a recorded human approval? */
  mode: AutonomyMode;
  /** Why it is gated (`none` when autonomous). `money` is the only non-toggleable gate. */
  gate: AutonomyGate;
  /** The resolved capability the action belongs to (explicit or inferred), or `null` if none matched. */
  capability: Capability | null;
  /** The channel the action uses, or `null`. */
  channel: Channel | null;
  /** Whether the money gate fired (mirrors `gate === "money"`). */
  money: boolean;
  /** The underlying money classification (signals/reason) for the audit trail. */
  moneyClassification: MoneyClassification;
  reason: string;
}

/** Verb → capability inference, evaluated in order; the first matching capability wins. */
const VERB_CAPABILITY: ReadonlyArray<readonly [Capability, ReadonlySet<string>]> = [
  ["deploy", new Set(["deploy", "ship", "release", "rollout", "cutover", "promote", "publish_release"])],
  [
    "outreach",
    new Set(["send", "email", "sms", "dm", "message", "notify", "broadcast", "outreach", "reply", "reach", "dispatch"]),
  ],
  ["publish", new Set(["publish", "post", "tweet", "share", "announce", "comment", "unpublish"])],
  ["draft", new Set(["draft", "compose", "prepare", "write", "generate", "create"])],
];

/** Tokenize an action string into lowercase letter-runs. */
function tokenize(value: string | null | undefined): string[] {
  return (value ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

/** Infer the capability from the action verb tokens, or `null` when no category matches. Pure + total. */
export function inferCapability(action: string): Capability | null {
  const tokens = new Set(tokenize(action));
  for (const [capability, verbs] of VERB_CAPABILITY) {
    for (const t of tokens) {
      if (verbs.has(t)) return capability;
    }
  }
  return null;
}

/**
 * Decide whether a proposed action runs autonomously or pauses for a recorded human approval. Order matters:
 * the money gate wins over everything (it is the one hard, non-toggleable gate), then a deliberately dialed-off
 * capability or channel gates, then the default — autonomous — applies. Pure + total.
 */
export function decideAutonomy(action: AutonomyActionDescriptor, caps: AutonomyCaps): AutonomyDecision {
  const safe = action && typeof action === "object" ? action : ({ action: "" } as AutonomyActionDescriptor);
  const moneyClassification = classifyMoney(safe);
  const capability = safe.capability ?? inferCapability(safe.action);
  const channel = safe.channel ?? null;

  // 1) Money is the ONLY hard gate. It is never toggled by `caps` — there is no path from a money action to
  //    "autonomous". This check runs first and unconditionally.
  if (moneyClassification.isMoney) {
    return {
      mode: "gated",
      gate: "money",
      capability,
      channel,
      money: true,
      moneyClassification,
      reason: moneyClassification.reason,
    };
  }

  // 2) A capability the user has deliberately dialed OFF gates its actions (opt-out; defaults ON).
  if (capability !== null && caps.capabilities[capability] === false) {
    return {
      mode: "gated",
      gate: "capability_disabled",
      capability,
      channel,
      money: false,
      moneyClassification,
      reason: `the "${capability}" capability is switched off for this workspace — paused for review`,
    };
  }

  // 3) A channel the user has deliberately dialed OFF gates its sends (opt-out; defaults ON).
  if (channel !== null && caps.channels[channel] === false) {
    return {
      mode: "gated",
      gate: "channel_disabled",
      capability,
      channel,
      money: false,
      moneyClassification,
      reason: `the "${channel}" channel is switched off for this workspace — paused for review`,
    };
  }

  // 4) The default: autonomous. Drafts, publishing, non-paid outreach, and deploys run on their own.
  return {
    mode: "autonomous",
    gate: "none",
    capability,
    channel,
    money: false,
    moneyClassification,
    reason: "autonomous by default — money is the only hard gate",
  };
}

/** Convenience predicate: will this action pause for a recorded human approval under the given caps? Pure. */
export function requiresApproval(action: AutonomyActionDescriptor, caps: AutonomyCaps): boolean {
  return decideAutonomy(action, caps).mode === "gated";
}

/** Is `name` one of the always-on guards (and therefore NOT a dial-down-able opt-out toggle)? Pure + total. */
export function isAlwaysOnGuard(name: string): name is AlwaysOnGuard {
  return (ALWAYS_ON_GUARDS as readonly string[]).includes(name);
}
