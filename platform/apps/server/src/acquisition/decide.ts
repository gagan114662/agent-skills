/**
 * Acquisition execution — pure decision core (issue #189, ADR-0189).
 *
 * The fleet's marketing agents DRAFT campaigns; #13 approves them; today the approved `external.send`
 * is **recorded-only** (no real ads/email/social/SEO ever leaves the building — "plans are not
 * customers", premortem #200). This module is the pure brain that governs the new real-send path:
 *
 *   - which **channel** a send belongs to (ads/email/social/seo) and its **reversibility** class (#200 §4),
 *   - whether a spend fits inside an **owner-approved budget envelope** (the envelope is the money
 *     decision; optimizations inside it are autonomous — AC1),
 *   - the **send gate** for a given action: `auto` (a venture earned it, within pre-committed caps),
 *     `approval` (the default — a human #13 yes), or `blocked` (a hard stop),
 *   - the **quarantine** rule (#200 §6): an action whose content was steered by an untrusted web read
 *     can NEVER be autonomous — it is forced back to a human, so a poisoned read can't drive a write,
 *   - the **retry** policy for transient social-publish failures (AC3).
 *
 * Everything here is a pure function of its inputs — no IO, no clock, no config reads. The IO seams
 * (providers, vault, repos) live in `execution.ts`/`default.ts`; the runtime flags in `caps.ts`.
 */

// ---- channels & kinds --------------------------------------------------------------------------

/** The four acquisition channels #189 makes executable. */
export const ACQUISITION_CHANNELS = ["ads", "email", "social", "seo"] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];

/**
 * The `external.send` payload kinds the dispatcher routes. These already exist as the marketing /
 * site send kinds (#123/#153) — this module maps each to its channel so one dispatcher can fan out.
 */
export const ACQUISITION_SEND_KINDS = [
  "ad.spend",
  "email.send",
  "social.post",
  "content.publish",
] as const;
export type AcquisitionSendKind = (typeof ACQUISITION_SEND_KINDS)[number];

const KIND_TO_CHANNEL: Record<AcquisitionSendKind, AcquisitionChannel> = {
  "ad.spend": "ads",
  "email.send": "email",
  "social.post": "social",
  "content.publish": "seo",
};

/** Map a send kind to its channel. Returns null for a kind this module does not own. */
export function channelForKind(kind: string): AcquisitionChannel | null {
  return (KIND_TO_CHANNEL as Record<string, AcquisitionChannel | undefined>)[kind] ?? null;
}

export function isAcquisitionSendKind(value: string): value is AcquisitionSendKind {
  return (ACQUISITION_SEND_KINDS as readonly string[]).includes(value);
}

// ---- reversibility (premortem #200 §4) ---------------------------------------------------------

/**
 * Reversibility class. `reversible` = trivially undone (unpublish an SEO page). `cheap` = undone at
 * small cost. `irreversible` = cannot be cleanly undone (an email is in inboxes; ad money is spent; a
 * social post is screenshotted; brand/deliverability/legal/money — #200 §4). Irreversible actions may
 * only go autonomous inside **pre-committed constraints** (the budget envelope / the daily send cap);
 * otherwise a human decides.
 */
export type Reversibility = "reversible" | "cheap" | "irreversible";

const REVERSIBILITY_BY_CHANNEL: Record<AcquisitionChannel, Reversibility> = {
  // SEO publishing writes to our own site — an unpublish/commit-revert fully reverses it.
  seo: "reversible",
  // Money out the door. Even a paused campaign cannot refund yesterday's spend.
  ads: "irreversible",
  // Mail in a stranger's inbox; a bad send burns sender reputation (deliverability is hard to undo).
  email: "irreversible",
  // A public post can be deleted, but it was already seen / cached / screenshotted — brand is exposed.
  social: "irreversible",
};

/** The reversibility class of a channel (premortem #200 §4). Total over the channel set. */
export function reversibilityForChannel(channel: AcquisitionChannel): Reversibility {
  return REVERSIBILITY_BY_CHANNEL[channel];
}

// ---- budget envelope (AC1: the money decision) -------------------------------------------------

/** The status of an owner-approved ad budget envelope. */
export const ENVELOPE_STATUSES = ["pending", "active", "exhausted", "paused", "revoked"] as const;
export type EnvelopeStatus = (typeof ENVELOPE_STATUSES)[number];

/** The owner-approved spend envelope: a cap and what has been spent against it. */
export interface BudgetEnvelope {
  capCents: number;
  spentCents: number;
  status: EnvelopeStatus;
}

export interface EnvelopeDecision {
  /** May this spend proceed autonomously (inside the envelope) right now? */
  allowed: boolean;
  /** Does it need a fresh owner decision (over the envelope, or no active envelope)? */
  requiresOwner: boolean;
  /** Cents left in the envelope (never negative). */
  remainingCents: number;
  reason: string;
}

/**
 * Decide whether a requested ad spend fits inside an owner-approved envelope. **The envelope is the
 * money decision** (AC1): the owner approves a cap once, and any number of bid optimizations spend
 * autonomously against it — until the cap is reached, the status leaves `active`, or the request is
 * not a positive amount. Spending *over* the envelope is never autonomous: it `requiresOwner`. A
 * non-positive request is a no-op (allowed, spends nothing).
 */
export function decideSpendWithinEnvelope(
  envelope: BudgetEnvelope,
  requestCents: number,
): EnvelopeDecision {
  const remainingCents = Math.max(0, envelope.capCents - envelope.spentCents);
  if (envelope.status !== "active") {
    return {
      allowed: false,
      requiresOwner: true,
      remainingCents,
      reason: `no active budget envelope (status: ${envelope.status})`,
    };
  }
  if (!Number.isFinite(requestCents) || requestCents <= 0) {
    return { allowed: true, requiresOwner: false, remainingCents, reason: "no spend requested" };
  }
  if (requestCents > remainingCents) {
    return {
      allowed: false,
      requiresOwner: true,
      remainingCents,
      reason: `over envelope: ${requestCents}¢ requested, ${remainingCents}¢ remaining`,
    };
  }
  return {
    allowed: true,
    requiresOwner: false,
    remainingCents,
    reason: "within owner-approved envelope",
  };
}

// ---- send gate (AC2: earn auto-send within caps) -----------------------------------------------

/** The outcome of the send-gate decision: autonomous, human-gated, or a hard stop. */
export type SendGate = "auto" | "approval" | "blocked";

/**
 * Provenance of the content being sent (premortem #200 §6). `human` / `agent` are trusted to drive an
 * autonomous send. `web_read` means the draft was steered by content an agent read off the open web
 * (a potential prompt-injection vector); `mixed` means at least one untrusted web read contributed.
 * Anything tainted by an untrusted web read is **quarantined** from autonomous writes.
 */
export type Provenance = "human" | "agent" | "web_read" | "mixed";

const TRUSTED_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["human", "agent"]);

/** Is this provenance trusted to drive an autonomous (no-human) send? (premortem #200 §6) */
export function isTrustedProvenance(p: Provenance): boolean {
  return TRUSTED_PROVENANCE.has(p);
}

export interface SendGateInput {
  channel: AcquisitionChannel;
  /** The channel's master flag is on for this workspace (`acquisition.<channel>`). */
  channelEnabled: boolean;
  /** The owner has connected the provider's credentials (#192 vault). No connect → no real send. */
  providerConnected: boolean;
  /** This is the owner's own workspace (auto-send rolls out owner-workspace-first). */
  ownerWorkspace: boolean;
  /** Auto-send has been explicitly enabled for this channel/workspace (off by default). */
  autoSendEnabled: boolean;
  /** The venture has externally-verified wins (#106/#200 §2) — it has EARNED a longer leash. */
  earnedAutoSend: boolean;
  /** Sends already made in the current window. */
  sentInWindow: number;
  /** The pre-committed per-window cap (the bound that makes an irreversible auto-send safe; #200 §4). */
  windowCap: number;
  /** Where the content came from (premortem #200 §6). */
  provenance: Provenance;
}

/**
 * Decide the gate for a single send. The default is always `approval` — a human #13 yes (sensitive
 * by default). A send may be promoted to `auto` ONLY when every earn-condition holds: the channel is
 * on, the provider is connected, it is the owner's workspace, auto-send is enabled, the venture has
 * earned it with external wins, the window cap is not yet reached, AND the content provenance is
 * trusted (premortem #200 §6 — a web-read-tainted draft is never autonomous). Missing credentials or
 * a reached cap is a hard `blocked` (an auto path that can't run must not silently fall to a human
 * spam loop). This is the pre-commitment constraint that bounds an irreversible auto-send (#200 §4).
 */
export function decideSendGate(input: SendGateInput): { gate: SendGate; reason: string } {
  if (!input.channelEnabled) {
    return { gate: "blocked", reason: `${input.channel} channel disabled` };
  }
  if (!input.providerConnected) {
    return { gate: "approval", reason: "provider not connected — owner must connect + approve" };
  }
  // The earn ladder for autonomous send. Any miss → the human gate (the safe default), never silent.
  if (!input.autoSendEnabled) {
    return { gate: "approval", reason: "auto-send not enabled" };
  }
  if (!input.ownerWorkspace) {
    return { gate: "approval", reason: "auto-send is owner-workspace-first" };
  }
  if (!input.earnedAutoSend) {
    return { gate: "approval", reason: "venture has not earned auto-send (no external wins yet)" };
  }
  if (input.windowCap <= 0 || input.sentInWindow >= input.windowCap) {
    return { gate: "blocked", reason: `window cap reached (${input.sentInWindow}/${input.windowCap})` };
  }
  if (!isTrustedProvenance(input.provenance)) {
    // premortem #200 §6: a poisoned read must never steer an autonomous write.
    return { gate: "approval", reason: `quarantined provenance (${input.provenance}) — human required` };
  }
  return { gate: "auto", reason: "earned auto-send within caps" };
}

/**
 * The quarantine clamp (premortem #200 §6), applied as a standalone latch so it can wrap ANY proposed
 * gate — including one a future evidence-priced policy (#119) might compute elsewhere. If the content
 * provenance is untrusted, an `auto` gate is forced down to `approval`; `approval`/`blocked` pass
 * through. A poisoned web read can therefore never be the thing that turns a send autonomous.
 */
export function applyQuarantine(
  gate: SendGate,
  provenance: Provenance,
): { gate: SendGate; quarantined: boolean; reason: string } {
  if (gate === "auto" && !isTrustedProvenance(provenance)) {
    return {
      gate: "approval",
      quarantined: true,
      reason: `quarantine: ${provenance} content cannot drive an autonomous send`,
    };
  }
  return { gate, quarantined: false, reason: "provenance permits the proposed gate" };
}

// ---- retry (AC3: social failures retry + surface) ----------------------------------------------

/** Classify a provider failure: a `transient` error is worth retrying; a `permanent` one is not. */
export type FailureKind = "transient" | "permanent";

export interface RetryDecision {
  retry: boolean;
  /** The attempt number to use for the NEXT try (1-based). */
  nextAttempt: number;
  /** Backoff before the next attempt (ms). 0 when not retrying. */
  delayMs: number;
  /** When true, the (final) failure must be surfaced to the founder brief (AC3). */
  surfaceToBrief: boolean;
  reason: string;
}

/** Exponential backoff schedule (ms) indexed by the just-failed attempt (1-based). Capped tail. */
const BACKOFF_MS = [0, 1_000, 5_000, 30_000] as const;

/**
 * Decide whether to retry a failed publish (AC3). A `transient` failure retries with exponential
 * backoff until `maxAttempts` is reached; a `permanent` failure never retries. Either way, once the
 * decision is "give up" the failure is flagged for the founder brief so a stuck channel is visible to
 * the owner (never a silent drop).
 */
export function decideRetry(
  attempt: number,
  maxAttempts: number,
  failure: FailureKind,
): RetryDecision {
  const exhausted = attempt >= maxAttempts;
  if (failure === "permanent") {
    return {
      retry: false,
      nextAttempt: attempt,
      delayMs: 0,
      surfaceToBrief: true,
      reason: "permanent failure — surfaced, not retried",
    };
  }
  if (exhausted) {
    return {
      retry: false,
      nextAttempt: attempt,
      delayMs: 0,
      surfaceToBrief: true,
      reason: `retries exhausted (${attempt}/${maxAttempts}) — surfaced`,
    };
  }
  const delayMs = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  return {
    retry: true,
    nextAttempt: attempt + 1,
    delayMs,
    surfaceToBrief: false,
    reason: `transient failure — retry ${attempt + 1}/${maxAttempts} after ${delayMs}ms`,
  };
}
