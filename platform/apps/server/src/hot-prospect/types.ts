/**
 * Hot-prospect alerting (issue #622) — pure data shapes. No IO, no clock, no randomness.
 *
 * The problem #622 fixes: a prospect's highest-intent moment (e.g. "visited pricing 3x today") passes
 * unnoticed, so the outreach agent reaches out late or not at all. The fix is a real-time detector that
 * watches a prospect's recent activity, and the moment that activity crosses an INTENT THRESHOLD, raises an
 * alert and queues a tailored follow-up — routed to the outreach agent + the user.
 *
 * Everything here is plain DATA fed to / returned from the pure detection + alert cores ({@link ./detect},
 * {@link ./alert}). Like the sibling self-contained modules (#611 lead-scoring, #674 content-guard,
 * #670 budget-governor, #585 memory-graph) this is a pure library: it does no IO and wires into no route,
 * schema barrel, or migration. Callers feed it signals and get an explainable detection / alert back.
 */

/**
 * A kind of tracked prospect activity. Each kind carries a different intent weight — a pricing-page view is a
 * far stronger buying signal than a blog visit. The list is deliberately small and product-agnostic; the
 * detector treats an unknown count of any kind as "no signal" (never as a negative).
 */
export type ProspectSignalKind =
  | "pricing_view"
  | "pricing_calculator"
  | "demo_session"
  | "doc_view"
  | "case_study_view"
  | "email_click"
  | "email_open"
  | "site_visit";

/** One observed activity event for a prospect. `at` is an ISO instant; the detector windows by it. */
export interface ProspectSignal {
  kind: ProspectSignalKind;
  /** ISO-8601 instant the activity happened. */
  at: string;
  /** Optional human detail for the alert card, e.g. the page path or campaign — DATA, never executed. */
  detail?: string;
}

/**
 * The recent activity for one prospect, handed to the detector. `prospectId` is an opaque, stable key (never
 * PII — mirrors the #400 leads centre / #611 lead id). Signals may be in any order; the detector windows and
 * sorts them.
 */
export interface ProspectActivity {
  prospectId: string;
  /** Optional display label for the alert (company / contact name). Falls back to `prospectId`. */
  label?: string;
  signals: ProspectSignal[];
}

/** A burst rule that fired: this many `kind` events landed inside the window, at/over its threshold. */
export interface FiredRule {
  kind: ProspectSignalKind;
  /** Human label for the alert, e.g. "Pricing-page views". */
  label: string;
  /** Count of this signal kind within the window. */
  count: number;
  /** The burst threshold that count met or exceeded. */
  threshold: number;
}

/**
 * The explainable result of running the detector over one prospect's windowed activity. `isHot` is the single
 * decision the service acts on; everything else explains it so an agent (or a human) can see *why* the
 * prospect crossed the line — nothing here is a black box.
 */
export interface IntentDetection {
  prospectId: string;
  /** Windowed weighted intent score (sum of per-kind count × weight, each kind saturating). */
  score: number;
  /** True when the prospect crossed the intent threshold OR any burst rule fired. */
  isHot: boolean;
  /** Per-kind burst rules that fired on their own (e.g. pricing_view ×3) — the strongest evidence. */
  firedRules: FiredRule[];
  /** Per-kind event counts within the window — the raw evidence behind the score. */
  counts: Partial<Record<ProspectSignalKind, number>>;
  /** One-line natural-language reason for the headline (the strongest fired rule, else the score). */
  reason: string;
}

/** Where a fired alert should be routed once it clears the approval queue. */
export type NotificationRoute = "outreach_agent" | "user";

/** A tailored follow-up the outreach agent should send (AFTER approval) — chosen from the trigger signal. */
export interface FollowUpDraft {
  /** Channel hint for the outreach agent. */
  channel: "email" | "in_app";
  subject: string;
  body: string;
  /** Which signal this follow-up was tailored to — the "why this message" trace. */
  basedOn: string;
}

/**
 * A raised hot-prospect alert: the explainable detection plus the queued, tailored follow-up. This is what the
 * service hands to the approval queue; the outbound notification never goes out until a human approves it.
 */
export interface HotProspectAlert {
  prospectId: string;
  /** Display label, or null when none was supplied. */
  label: string | null;
  /** The intent score at the moment of firing. */
  score: number;
  /** The headline reason (from {@link IntentDetection.reason}). */
  reason: string;
  /** The burst rules that fired (the evidence). */
  firedRules: FiredRule[];
  /** The tailored follow-up queued for the outreach agent to send post-approval. */
  followUp: FollowUpDraft;
  /** Where this alert is routed once approved. */
  routes: NotificationRoute[];
  /** ISO instant the alert was raised. */
  raisedAt: string;
}
