/**
 * Notification types + the preference gate (issue #8). Pure and dependency-free so it runs in
 * the no-Redis/no-DB unit job and is the single source of truth for "should this activity become
 * a notification?". Persistence, delivery, and triggers live elsewhere; this only classifies.
 */

/**
 * The activity kinds that become a notification. `approval` backs both pending-review and terminal
 * approval updates so open queues can refresh live (ADR-0008).
 */
export const NOTIFICATION_TYPES = [
  "mention",
  "dm",
  "reply",
  "assignment",
  "approval",
  "inbound_lead",
  "deliverable_feedback",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

/** A member's notification preferences. `muted` silences all; `mentionOnly` keeps only mentions. */
export interface NotificationPrefs {
  muted: boolean;
  mentionOnly: boolean;
}

/** Preferences applied when a member has no row yet: everything is delivered. */
export const DEFAULT_PREFS: NotificationPrefs = { muted: false, mentionOnly: false };

/**
 * The gate that decides whether an activity of `type` becomes a notification for a member with
 * `prefs`. `muted` wins over everything; otherwise `mentionOnly` lets only `mention` through;
 * otherwise every type is delivered. Gating happens at *creation* time (ADR-0008): a suppressed
 * notification is never written and never pushed.
 */
export function shouldNotify(type: NotificationType, prefs: NotificationPrefs): boolean {
  if (prefs.muted) return false;
  if (prefs.mentionOnly) return type === "mention";
  return true;
}
