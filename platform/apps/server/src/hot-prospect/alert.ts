/**
 * Hot-prospect alert + tailored follow-up builder (issue #622). Pure + deterministic: same detection + label +
 * timestamp in, same {@link HotProspectAlert} out. No clock (the caller passes `raisedAt`), no IO.
 *
 * The acceptance criterion has two halves — "fires an alert" AND "queues a TAILORED follow-up". The follow-up
 * is tailored by mapping the strongest trigger signal to a message template, so a prospect who hammered the
 * pricing page gets a pricing-themed nudge, while one deep in the docs gets an implementation-themed one. The
 * `basedOn` field records which signal drove the choice — the same explainability the detector carries.
 */

import type {
  FollowUpDraft,
  HotProspectAlert,
  IntentDetection,
  NotificationRoute,
  ProspectActivity,
  ProspectSignalKind,
} from "./types.js";

/** Default routing: a fired alert goes to the outreach agent (to act) AND the user (to know). */
export const DEFAULT_ROUTES: readonly NotificationRoute[] = ["outreach_agent", "user"];

/** A follow-up template keyed by the trigger signal kind: the channel + the message shape. */
interface FollowUpTemplate {
  channel: FollowUpDraft["channel"];
  subject: string;
  /** `{who}` is replaced with the prospect's display label. */
  body: string;
}

/**
 * Tailored follow-up copy per trigger kind. Deliberately concise, on-brand-neutral starting points — a real
 * deployment would route these through the #588 campaign-brief voice, but the *tailoring* (which template) is
 * the value #622 asks for, and it is deterministic from the signal.
 */
const FOLLOW_UP_TEMPLATES: Record<ProspectSignalKind, FollowUpTemplate> = {
  pricing_view: {
    channel: "email",
    subject: "Questions on pricing?",
    body: "Hi {who} — noticed you were comparing plans. Happy to walk you through pricing and find the right fit. Want a quick 15 min?",
  },
  pricing_calculator: {
    channel: "email",
    subject: "Let's size the right plan",
    body: "Hi {who} — saw you were estimating costs. I can sanity-check the numbers for your use case and flag any volume discounts. Worth a quick call?",
  },
  demo_session: {
    channel: "email",
    subject: "How was the demo?",
    body: "Hi {who} — thanks for trying the demo. Want me to tailor a walkthrough to your workflow and answer anything that came up?",
  },
  case_study_view: {
    channel: "email",
    subject: "Results from teams like yours",
    body: "Hi {who} — glad the case studies were useful. I can share how a similar team rolled this out and the results they saw. Open to a chat?",
  },
  doc_view: {
    channel: "email",
    subject: "Need a hand with setup?",
    body: "Hi {who} — looks like you were deep in the docs. I can shortcut the setup and answer integration questions. Want me to help you get started?",
  },
  email_click: {
    channel: "email",
    subject: "Picking up where you left off",
    body: "Hi {who} — thanks for the click-through. Anything I can answer to help you evaluate? Happy to send the right resources.",
  },
  email_open: {
    channel: "in_app",
    subject: "Still exploring?",
    body: "Hi {who} — checking in to see if you have questions as you evaluate. I'm here to help whenever it's useful.",
  },
  site_visit: {
    channel: "in_app",
    subject: "Welcome back",
    body: "Hi {who} — good to see you back. Want a quick overview tailored to what you're looking for?",
  },
};

/**
 * The trigger kind that should drive the tailored follow-up: the strongest fired burst rule, else the
 * highest-weighted kind that actually has signal. Never returns a kind with zero count.
 */
function triggerKind(detection: IntentDetection): ProspectSignalKind | null {
  const topFired = detection.firedRules[0];
  if (topFired) return topFired.kind;

  // No burst rule fired (score-threshold path): pick the kind with the most events, ties by template order.
  let best: ProspectSignalKind | null = null;
  let bestCount = 0;
  for (const kind of Object.keys(FOLLOW_UP_TEMPLATES) as ProspectSignalKind[]) {
    const count = detection.counts[kind] ?? 0;
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** Build the tailored follow-up draft for a detection + prospect. Deterministic from the trigger signal. */
export function buildFollowUp(detection: IntentDetection, activity: ProspectActivity): FollowUpDraft {
  const who = activity.label?.trim() || "there";
  const kind = triggerKind(detection);
  const template = kind ? FOLLOW_UP_TEMPLATES[kind] : null;

  if (!template || !kind) {
    return {
      channel: "in_app",
      subject: "A prospect is showing intent",
      body: `Hi ${who} — reaching out while your interest is fresh. Anything I can help with?`,
      basedOn: "overall intent score",
    };
  }

  return {
    channel: template.channel,
    subject: template.subject,
    body: template.body.replace("{who}", who),
    basedOn: kind,
  };
}

/**
 * Assemble the full {@link HotProspectAlert} for a hot detection: the explainable evidence plus the tailored,
 * queued follow-up. Throws if called on a non-hot detection — the service only ever builds alerts for crossings.
 */
export function buildAlert(
  detection: IntentDetection,
  activity: ProspectActivity,
  raisedAt: string,
  routes: readonly NotificationRoute[] = DEFAULT_ROUTES,
): HotProspectAlert {
  if (!detection.isHot) {
    throw new Error("buildAlert called on a prospect that is not hot");
  }
  return {
    prospectId: detection.prospectId,
    label: activity.label?.trim() ? activity.label.trim() : null,
    score: detection.score,
    reason: detection.reason,
    firedRules: detection.firedRules,
    followUp: buildFollowUp(detection, activity),
    routes: [...routes],
    raisedAt,
  };
}
