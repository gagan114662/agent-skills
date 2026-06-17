/**
 * Deliverable delivery — the pure routing brain (issue #295, ADR-0295).
 *
 * The v5 console departments (Scout/SEO, Echo/social, Quill/content, Postmark/email, Bid/ads) draft work
 * and STOP: a completed session surfaces an `agent.deliverable` review card in the #13 APPROVAL NEEDED
 * queue (#248), but approving it was a pure acknowledgement — nothing ever shipped. This module decides,
 * for an approved deliverable, WHETHER and through WHICH channel it ships.
 *
 * Two safety properties are encoded here, not by convention:
 *
 *  1. **Injection defense (premortem #200 §6).** The routing decision — which channel, whether to ship —
 *     is derived PURELY from the structural `department` (which agent/channel produced the draft) and the
 *     workspace flags. It NEVER inspects the `draft` text. A poisoned web read folded into the draft is
 *     opaque DATA (the content to publish); it can never redirect the ship to a different channel/recipient
 *     or flip a flag. The draft's only role is `nonEmpty` — does content exist to ship at all.
 *
 *  2. **Default OFF, owner-workspace-first (issue #295 hard constraint).** {@link resolveDeliveryFlags}
 *     returns all-off unless the master flag is on AND (broadened explicitly OR this is the owner's own
 *     workspace). A deployment that sets nothing keeps today's behavior exactly: the deliverable executor
 *     stays a pure acknowledgement.
 *
 * Pure + dependency-free so it runs in the no-DB unit job and is the single source of truth for "does this
 * deliverable ship, and how?".
 */

import { departmentForChannel } from "../marketing/blueprint.js";

/**
 * The delivery channels a deliverable can ship through. `publish` is a live, reachable public page
 * (reversible — a page can be taken down). `social`/`email` are IRREVERSIBLE outward sends
 * (deliverability + brand cannot be un-rung). Ads is deliberately absent: an ads deliverable is a SPEND
 * PLAN, and real ad spend is money-gated separately (#189/#187), never shipped through this content path.
 */
export const DELIVERY_CHANNELS = ["publish", "social", "email"] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/** Reversibility class (premortem #200 §4) carried on the decision so the receipt/audit reflects it. */
export type DeliveryReversibility = "reversible" | "irreversible";

/**
 * The structural department key → delivery channel mapping. Scout/SEO + Quill/content publish a live page;
 * Echo/social posts; Postmark/email sends. Every other department (ads, analytics, brand, reach, the shared
 * rooms, an unknown channel) returns `null` — not shippable through this path. `null` in ⇒ `null` out.
 */
export function channelForDepartment(department: string | null): DeliveryChannel | null {
  switch (department) {
    case "seo":
    case "content":
      return "publish";
    case "social":
      return "social";
    case "email":
      return "email";
    default:
      return null;
  }
}

/** The structural department a deliverable belongs to, from the channel NAME it was drafted in (#123). */
export function departmentForDeliverableChannel(channelName: string | null): string | null {
  if (!channelName) return null;
  return departmentForChannel(channelName)?.key ?? null;
}

/** Reversibility of a channel: a published page can be taken down; a sent post/email cannot be unsent. */
export function reversibilityForChannel(channel: DeliveryChannel): DeliveryReversibility {
  return channel === "publish" ? "reversible" : "irreversible";
}

/** The resolved per-channel ship flags for a workspace. Every channel defaults OFF. */
export interface DeliveryFlags {
  /** Master switch — when false every channel is off regardless of the per-channel flags. */
  enabled: boolean;
  publish: boolean;
  social: boolean;
  email: boolean;
}

/** All-off flags — the safe default (today's behavior: a deliverable is acknowledged, never shipped). */
export const DELIVERY_FLAGS_OFF: DeliveryFlags = {
  enabled: false,
  publish: false,
  social: false,
  email: false,
};

/** The non-secret delivery config shape (mirrors `config/schema.ts deliverySchema`). All fields optional. */
export interface DeliveryConfigInput {
  enabled?: boolean;
  publish?: boolean;
  social?: boolean;
  email?: boolean;
  /** The owner's own workspace id — delivery rolls out owner-workspace-first. */
  ownerWorkspaceId?: string;
  /** Restrict live delivery to the owner workspace (default true). Set false to broaden to all tenants. */
  ownerWorkspaceOnly?: boolean;
}

/**
 * Resolve a workspace's ship flags from the layered config (#58) — DEFAULT OFF, owner-workspace-first.
 *
 * The gate is two-pronged: the master `enabled` flag must be on, AND the workspace must be in scope. Scope
 * defaults to the OWNER workspace only (`ownerWorkspaceOnly` defaults true), so turning the feature on
 * without naming the owner workspace ships to NObody — the safest possible default. Set
 * `ownerWorkspaceOnly: false` to broaden to every tenant once the owner workspace has proven the path.
 * Pure + total so the rollout is unit-testable without a DB.
 */
export function resolveDeliveryFlags(
  config: DeliveryConfigInput | undefined,
  workspaceId: string,
): DeliveryFlags {
  if (!config || config.enabled !== true) return DELIVERY_FLAGS_OFF;
  const ownerOnly = config.ownerWorkspaceOnly !== false; // default true
  const inScope = ownerOnly
    ? config.ownerWorkspaceId !== undefined && config.ownerWorkspaceId === workspaceId
    : true;
  if (!inScope) return DELIVERY_FLAGS_OFF;
  return {
    enabled: true,
    publish: config.publish === true,
    social: config.social === true,
    email: config.email === true,
  };
}

/** Everything the pure classifier needs. `draft` is read ONLY for emptiness — never for routing. */
export interface DeliveryDecisionInput {
  /** The structural department that produced the deliverable (NULL for a non-department channel). */
  department: string | null;
  /** The resolved ship flags for this workspace. */
  flags: DeliveryFlags;
  /** The drafted content. Inspected ONLY for emptiness (is there anything to ship?), never for routing. */
  draft: string;
}

/** The pure routing decision. `ship:false` carries a reason for the audit trail / receipt detail. */
export type DeliveryDecision =
  | { ship: false; reason: string }
  | { ship: true; channel: DeliveryChannel; reversibility: DeliveryReversibility };

/**
 * Decide whether an approved deliverable ships, and through which channel. Order of checks (fail-closed):
 *   1. master flag off                     → no ship (today's behavior)
 *   2. department not shippable            → no ship (ads/analytics/brand/reach/shared/unknown)
 *   3. that channel's flag off             → no ship
 *   4. empty draft                         → no ship (nothing to publish)
 *   5. otherwise                           → ship via the structural channel, carrying its reversibility.
 *
 * The decision is a PURE function of structural inputs (department + flags) and `draft` emptiness — never
 * of the draft's CONTENT (injection defense, premortem #200 §6).
 */
export function decideDelivery(input: DeliveryDecisionInput): DeliveryDecision {
  if (!input.flags.enabled) {
    return { ship: false, reason: "delivery disabled for this workspace" };
  }
  const channel = channelForDepartment(input.department);
  if (!channel) {
    return {
      ship: false,
      reason: `department "${input.department ?? "none"}" is not shippable through delivery`,
    };
  }
  if (!input.flags[channel]) {
    return { ship: false, reason: `the ${channel} channel is not enabled for this workspace` };
  }
  if (input.draft.trim().length === 0) {
    return { ship: false, reason: "deliverable has no draft content to ship" };
  }
  return { ship: true, channel, reversibility: reversibilityForChannel(channel) };
}
