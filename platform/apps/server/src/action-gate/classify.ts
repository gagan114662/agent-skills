/**
 * The PURE classifier at the heart of issue #670's confirm-gate: decide whether a proposed action is
 * PUBLIC or IRREVERSIBLE and therefore must pause for an explicit, recorded human approval before it runs.
 * "publish / send / post / delete and other irreversible external actions" — the issue's literal scope — plus
 * anything whose blast radius cannot be cheaply undone or that leaves the building.
 *
 * Design (mirrors the #674 content-guard gate — a SAFETY layer that strictly TIGHTENS, never loosens):
 *  - **Additive only.** {@link classifyAction} can only ever ADD a confirmation requirement. There is no input
 *    that turns a public/irreversible verb into "autonomous".
 *  - **Fail-closed on uncertainty.** An unknown verb with no reversibility/visibility hints is treated as the
 *    dangerous case (`mustConfirm: true`). A caller opts a genuinely-safe internal action OUT explicitly by
 *    passing `reversible: true` AND `public: false` — never the other way around.
 *  - **Structural fields only, no free text.** The decision reads a verb token + boolean hints, never untrusted
 *    prose, so a poisoned payload can never flip the verdict (the #200 §6 trust boundary).
 *
 * Pure + total: no IO, no clock, no randomness in the decision. The {@link actionFingerprint} helper hashes the
 * action so an approval can be bound to the exact action it was granted for (replay-proofing in the service).
 */

import { createHash } from "node:crypto";

/**
 * Outward-facing verbs — an action whose effect is visible OUTSIDE the system (a real recipient, a public URL,
 * a third-party surface). Publishing/sending/posting a thing reaches people we cannot recall it from.
 */
const PUBLIC_VERBS: ReadonlySet<string> = new Set([
  "publish",
  "unpublish",
  "post",
  "send",
  "email",
  "sms",
  "dm",
  "message",
  "broadcast",
  "tweet",
  "share",
  "announce",
  "notify",
  "comment",
  "reply",
  "deploy",
  "release",
  "ship",
  "dispatch",
  "submit",
  "push",
  "fanout",
]);

/**
 * Irreversible verbs — an action whose blast radius cannot be cheaply undone: a sent message is in a stranger's
 * inbox forever (#200 §4), a deleted record is gone, money out the door does not come back. Note many entries
 * are also in {@link PUBLIC_VERBS}; the two axes are independent and either one alone forces a confirmation.
 */
const IRREVERSIBLE_VERBS: ReadonlySet<string> = new Set([
  // outward, un-recallable
  "send",
  "post",
  "publish",
  "broadcast",
  "dispatch",
  "submit",
  "deploy",
  "release",
  "email",
  // destructive
  "delete",
  "destroy",
  "remove",
  "purge",
  "drop",
  "erase",
  "wipe",
  "truncate",
  "overwrite",
  "revoke",
  "terminate",
  "cancel",
  "reset",
  // money / credentials
  "charge",
  "pay",
  "payout",
  "refund",
  "transfer",
  "withdraw",
  "rotate",
  "mint",
  "sign",
]);

/**
 * Verbs known to be internal AND cheaply reversible — reads, drafts, dry-runs, pure computation. These are the
 * only operations that classify autonomous WITHOUT an explicit `reversible`/`public` hint. Kept deliberately
 * conservative: anything not on this list (and not declared safe by the caller) fails closed to a confirmation.
 */
const SAFE_VERBS: ReadonlySet<string> = new Set([
  "read",
  "get",
  "list",
  "fetch",
  "view",
  "show",
  "search",
  "query",
  "lookup",
  "preview",
  "draft",
  "compose",
  "prepare",
  "validate",
  "check",
  "verify",
  "plan",
  "analyze",
  "inspect",
  "render",
  "simulate",
  "dryrun",
  "estimate",
  "score",
  "classify",
  "summarize",
  "extract",
  "parse",
  "lint",
  "diff",
]);

/** A description of an action an actuator is about to take, for the gate to rule on. Structural fields only. */
export interface ActionDescriptor {
  /**
   * The operation, e.g. `publish`, `email.send`, `social.publish_post`, `db.read`, `blog.delete`. The classifier
   * tokenizes this on non-letters and matches ANY token against its verb sets, so namespaced/compound forms
   * (`email.send`, `publish_post`) resolve to their real verb. For audit/messaging too.
   */
  action: string;
  /** Where the effect lands (a URL, channel, table, recipient). Audit/fingerprint only — does not steer the verdict. */
  surface?: string | null;
  /** Does the effect reach OUTSIDE the system (a public audience / third party)? Omit to let the verb decide. */
  public?: boolean;
  /** Can the effect be cheaply undone? Omit to let the verb decide. `false` forces a confirmation on its own. */
  reversible?: boolean;
  /** A short human summary for the review queue (e.g. "Send launch email to 4,200 subscribers"). */
  summary?: string | null;
  /** The structural payload that scopes the action (e.g. `{ recipientCount: 4200 }`). Bound into the fingerprint. */
  payload?: Record<string, unknown> | null;
}

/** Tunables that EXTEND (never relax) the verb sets — resolved from env in `caps.ts`. */
export interface ClassifyPolicy {
  /** Extra verbs to treat as irreversible (a deployment can broaden the danger list, never shrink it). */
  extraIrreversibleVerbs?: readonly string[];
  /** Extra verbs to treat as public/outward. */
  extraPublicVerbs?: readonly string[];
  /** Extra verbs to treat as internal-reversible (e.g. a known-safe internal op). Never overrides a danger verb. */
  extraSafeVerbs?: readonly string[];
}

/** A three-state axis verdict: definitively dangerous, definitively safe, or indeterminate (→ fail closed). */
export type AxisVerdict = "irreversible" | "reversible" | "unknown";
export type VisibilityVerdict = "public" | "internal" | "unknown";

/** The high-level reason an action is gated, for the queue label. */
export type GateClass = "public" | "irreversible" | "public+irreversible" | "uncertain" | "none";

/** The classifier's verdict on a single proposed action. Pure data. */
export interface ActionClassification {
  /** THE answer: must this action pause for a recorded human approval before it can execute? */
  mustConfirm: boolean;
  reversibility: AxisVerdict;
  visibility: VisibilityVerdict;
  /** A label for the review queue / metrics. `none` only when the action is definitively internal + reversible. */
  klass: GateClass;
  /** The verb tokens that matched a danger set (for the audit trail / messaging). */
  matchedVerbs: string[];
  reason: string;
}

/** Tokenize an action string into lowercase letter-runs: `social.publish_post` → `["social","publish","post"]`. */
function tokenize(action: string): string[] {
  return (action ?? "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length > 0);
}

function withExtras(base: ReadonlySet<string>, extras?: readonly string[]): ReadonlySet<string> {
  if (!extras || extras.length === 0) return base;
  const out = new Set(base);
  for (const e of extras) {
    const t = e.trim().toLowerCase();
    if (t) out.add(t);
  }
  return out;
}

/**
 * Classify a proposed action. Pure + total.
 *
 * The two axes are decided independently, each fail-closed:
 *  - **reversibility**: an explicit `reversible` flag wins; else a known irreversible verb ⇒ `irreversible`,
 *    a known safe verb ⇒ `reversible`, otherwise `unknown`.
 *  - **visibility**: an explicit `public` flag wins; else a known public verb ⇒ `public`, a known safe verb ⇒
 *    `internal`, otherwise `unknown`.
 *
 * `mustConfirm` is true UNLESS the action is BOTH definitively `reversible` AND definitively `internal` — i.e.
 * any irreversibility, any public reach, or any uncertainty on either axis forces the confirmation. There is no
 * path from a public/irreversible/uncertain action to "autonomous".
 */
export function classifyAction(
  action: ActionDescriptor,
  policy: ClassifyPolicy = {},
): ActionClassification {
  const safe = action && typeof action === "object" ? action : { action: "" };
  const tokens = tokenize(safe.action);

  const irreversibleSet = withExtras(IRREVERSIBLE_VERBS, policy.extraIrreversibleVerbs);
  const publicSet = withExtras(PUBLIC_VERBS, policy.extraPublicVerbs);
  const safeSet = withExtras(SAFE_VERBS, policy.extraSafeVerbs);

  const matchedIrreversible = tokens.filter((t) => irreversibleSet.has(t));
  const matchedPublic = tokens.filter((t) => publicSet.has(t));
  const matchedSafe = tokens.filter((t) => safeSet.has(t));

  // Reversibility axis — explicit flag wins, then verb, then fail-closed to unknown.
  let reversibility: AxisVerdict;
  if (safe.reversible === false) reversibility = "irreversible";
  else if (matchedIrreversible.length > 0) reversibility = "irreversible";
  else if (safe.reversible === true) reversibility = "reversible";
  else if (matchedSafe.length > 0) reversibility = "reversible";
  else reversibility = "unknown";

  // Visibility axis — explicit flag wins, then verb, then fail-closed to unknown.
  let visibility: VisibilityVerdict;
  if (safe.public === true) visibility = "public";
  else if (matchedPublic.length > 0) visibility = "public";
  else if (safe.public === false) visibility = "internal";
  else if (matchedSafe.length > 0) visibility = "internal";
  else visibility = "unknown";

  const definitivelySafe = reversibility === "reversible" && visibility === "internal";
  const mustConfirm = !definitivelySafe;

  const klass = classOf(reversibility, visibility);
  const matchedVerbs = [...new Set([...matchedIrreversible, ...matchedPublic])];

  return {
    mustConfirm,
    reversibility,
    visibility,
    klass,
    matchedVerbs,
    reason: explain(klass, reversibility, visibility, matchedVerbs),
  };
}

function classOf(reversibility: AxisVerdict, visibility: VisibilityVerdict): GateClass {
  const irreversible = reversibility === "irreversible";
  const pub = visibility === "public";
  if (irreversible && pub) return "public+irreversible";
  if (pub) return "public";
  if (irreversible) return "irreversible";
  if (reversibility === "reversible" && visibility === "internal") return "none";
  return "uncertain";
}

function explain(
  klass: GateClass,
  reversibility: AxisVerdict,
  visibility: VisibilityVerdict,
  matchedVerbs: string[],
): string {
  const verbs = matchedVerbs.length > 0 ? ` (${matchedVerbs.join(", ")})` : "";
  switch (klass) {
    case "public+irreversible":
      return `public, irreversible action${verbs} — recorded human approval required before it executes`;
    case "public":
      return `public/outward action${verbs} — recorded human approval required before it executes`;
    case "irreversible":
      return `irreversible action${verbs} — recorded human approval required before it executes`;
    case "uncertain":
      return `cannot prove this action is internal and reversible (reversibility=${reversibility}, visibility=${visibility}) — recorded human approval required (fail-closed)`;
    case "none":
      return "internal, reversible action — no confirmation required";
  }
}

/** Convenience predicate: does this action require a recorded human approval? */
export function requiresConfirmation(action: ActionDescriptor, policy: ClassifyPolicy = {}): boolean {
  return classifyAction(action, policy).mustConfirm;
}

/**
 * A deterministic fingerprint of the action's load-bearing fields. An approval is bound to this fingerprint so a
 * yes for "delete record 5" can never be replayed to authorize "delete record 99" — the service refuses to
 * consume an approval whose fingerprint does not match the action being retried (#200 §4: approval is per-action,
 * never a blanket grant). Canonical (sorted payload keys) so equivalent actions hash equally. Pure + total.
 */
export function actionFingerprint(action: ActionDescriptor): string {
  const canonical = JSON.stringify({
    action: (action?.action ?? "").trim().toLowerCase(),
    surface: action?.surface ?? null,
    public: action?.public ?? null,
    reversible: action?.reversible ?? null,
    payload: canonicalize(action?.payload ?? null),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Recursively sort object keys so payload field order does not change the fingerprint. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => [k, canonicalize((value as Record<string, unknown>)[k])] as const);
  return Object.fromEntries(entries);
}
