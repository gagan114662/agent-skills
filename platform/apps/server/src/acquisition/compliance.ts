/**
 * Acquisition execution — email compliance & deliverability (issue #189, ADR-0189, AC2).
 *
 * Email is the most irreversible acquisition channel (#200 §4): a bad send is in a stranger's inbox
 * forever and burns sender reputation. So the law and the laws of deliverability are enforced IN CODE,
 * not left to an agent's good intentions:
 *
 *   - **Suppression** — anyone who bounced, complained, or unsubscribed is a hard block. The list is
 *     consulted on every send; a suppressed recipient is dropped (never "the agent should remember").
 *   - **CAN-SPAM / GDPR footer** — every marketing email must carry a physical postal address, a
 *     working unsubscribe, and (GDPR) a data-rights line. The footer is built + appended here.
 *   - **Domain warmup** — a fresh sending domain may only send a ramping number of mails per day, so
 *     we don't torch deliverability by blasting from cold (the pre-commitment bound for an
 *     irreversible channel, #200 §4).
 *
 * All pure. `execution.ts` consults a suppression Set loaded from the repo; this file never does IO.
 */

// ---- suppression list ---------------------------------------------------------------------------

/** Why a recipient is suppressed. `bounce`/`complaint` come from ESP webhooks; the rest are explicit. */
export const SUPPRESSION_REASONS = ["bounce", "complaint", "unsubscribe", "manual"] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Normalize an email for suppression matching: trim + lowercase (RFC local-parts are case-sensitive
 * in theory, but every real mailbox is case-insensitive; suppression must over-match, never under). */
export function normalizeRecipient(email: string): string {
  return email.trim().toLowerCase();
}

/** Is this recipient on the suppression list? (membership test over a normalized Set). */
export function isSuppressed(email: string, suppressed: ReadonlySet<string>): boolean {
  return suppressed.has(normalizeRecipient(email));
}

/** Split recipients into the allowed set and the suppressed set (both normalized, de-duplicated). */
export function filterSuppressed(
  recipients: string[],
  suppressed: ReadonlySet<string>,
): { allowed: string[]; suppressed: string[] } {
  const allowed: string[] = [];
  const blocked: string[] = [];
  const seen = new Set<string>();
  for (const raw of recipients) {
    const r = normalizeRecipient(raw);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    (isSuppressed(r, suppressed) ? blocked : allowed).push(r);
  }
  return { allowed, suppressed: blocked };
}

/**
 * Map an ESP webhook event type to a suppression reason, or null when the event is not suppressing.
 * Covers the common ESP vocabularies (Postmark: `Bounce`/`SpamComplaint`; SendGrid: `bounce`/`dropped`
 * /`spamreport`/`unsubscribe`; SES: `Bounce`/`Complaint`). Case-insensitive.
 */
export function reasonFromWebhook(eventType: string): SuppressionReason | null {
  const e = eventType.trim().toLowerCase();
  if (e.includes("complaint") || e.includes("spam")) return "complaint";
  if (e.includes("bounce") || e === "dropped" || e === "hardbounce") return "bounce";
  if (e.includes("unsub")) return "unsubscribe";
  return null;
}

// ---- CAN-SPAM / GDPR footer ---------------------------------------------------------------------

/** The non-secret facts a compliant footer needs. The owner supplies these once (via config/onboarding). */
export interface FooterInfo {
  /** The sending brand / legal entity. */
  brandName: string;
  /** A real physical postal address (CAN-SPAM §5 requires one). */
  postalAddress: string;
  /** A working one-click unsubscribe URL (CAN-SPAM + RFC 8058). */
  unsubscribeUrl: string;
}

/** A marker the footer carries so `hasComplianceFooter` can detect an already-appended footer (idempotency). */
const FOOTER_MARKER = "<!-- acq:compliance-footer -->";

/** Has a compliance footer already been appended to this body? */
export function hasComplianceFooter(body: string): boolean {
  return body.includes(FOOTER_MARKER);
}

/**
 * Build the CAN-SPAM + GDPR footer text. Includes: who is sending (brand), a physical postal address
 * (CAN-SPAM), a working unsubscribe link (CAN-SPAM/RFC 8058), and a GDPR data-rights line. The marker
 * comment lets us detect double-append.
 */
export function buildComplianceFooter(info: FooterInfo): string {
  return [
    FOOTER_MARKER,
    `You are receiving this email from ${info.brandName}.`,
    info.postalAddress,
    `Unsubscribe: ${info.unsubscribeUrl}`,
    "Under GDPR you may request access to, correction of, or deletion of your personal data at any time.",
  ].join("\n");
}

/** Append the compliance footer to a body, idempotently (a second call is a no-op). */
export function appendComplianceFooter(body: string, info: FooterInfo): string {
  if (hasComplianceFooter(body)) return body;
  return `${body}\n\n${buildComplianceFooter(info)}`;
}

/** Is this footer info complete enough to be lawful? (all three required parts present, non-empty). */
export function isFooterInfoComplete(info: Partial<FooterInfo> | undefined): info is FooterInfo {
  return Boolean(
    info && info.brandName?.trim() && info.postalAddress?.trim() && info.unsubscribeUrl?.trim(),
  );
}

export interface EmailComplianceInput {
  body: string;
  recipients: string[];
  suppressed: ReadonlySet<string>;
  footerInfo: Partial<FooterInfo> | undefined;
}

export interface EmailComplianceResult {
  ok: boolean;
  violations: string[];
  /** Recipients cleared to send after suppression filtering. */
  allowedRecipients: string[];
  /** Recipients dropped by suppression. */
  suppressedRecipients: string[];
}

/**
 * The send-time compliance gate for an email (AC2). Fails (`ok:false`) when: the footer info is
 * incomplete (no postal address / unsubscribe), the body carries no compliance footer, or there is no
 * deliverable recipient left after suppression. Suppressed recipients are always dropped (their
 * presence is itself a violation to record, but the send may still proceed to the allowed remainder).
 */
export function checkEmailCompliance(input: EmailComplianceInput): EmailComplianceResult {
  const violations: string[] = [];
  const { allowed, suppressed } = filterSuppressed(input.recipients, input.suppressed);

  if (!isFooterInfoComplete(input.footerInfo)) {
    violations.push("missing CAN-SPAM footer info (brand, postal address, unsubscribe required)");
  }
  if (!hasComplianceFooter(input.body)) {
    violations.push("email body has no compliance footer");
  }
  if (suppressed.length > 0) {
    violations.push(`${suppressed.length} suppressed recipient(s) dropped`);
  }
  if (allowed.length === 0) {
    violations.push("no deliverable recipients after suppression");
  }

  // A dropped-suppressed warning alone does not fail the send; a missing footer / address / no
  // deliverable recipient does. Compute hard-fail independently of the (advisory) suppression note.
  const hardFail =
    !isFooterInfoComplete(input.footerInfo) ||
    !hasComplianceFooter(input.body) ||
    allowed.length === 0;

  return {
    ok: !hardFail,
    violations,
    allowedRecipients: allowed,
    suppressedRecipients: suppressed,
  };
}

// ---- domain warmup ------------------------------------------------------------------------------

/**
 * The per-day send ceiling while a fresh domain warms up (mails/day). Index = days since first send
 * (day 0 = the first day). After the schedule runs out the domain is considered warm — no cap.
 * Conservative ramp: a cold domain that blasts thousands on day one gets its reputation shredded and
 * lands in spam folders permanently (the irreversible blast-radius #200 §4 warns about).
 */
export const WARMUP_SCHEDULE_PER_DAY = [50, 100, 500, 1_000, 5_000, 10_000, 20_000, 50_000] as const;

/** The send cap for a given warmup day. Days past the schedule are warm (Number.POSITIVE_INFINITY). */
export function warmupCapForDay(dayIndex: number): number {
  if (dayIndex < 0) return 0;
  if (dayIndex >= WARMUP_SCHEDULE_PER_DAY.length) return Number.POSITIVE_INFINITY;
  return WARMUP_SCHEDULE_PER_DAY[dayIndex]!;
}

export interface WarmupDecision {
  allowed: boolean;
  capForDay: number;
  /** How many of `requested` fit under today's remaining headroom. */
  grantable: number;
  reason: string;
}

/**
 * Decide how much of a requested batch a warming domain may send today. Pure function of (warmup day,
 * already-sent-today, requested). Grants up to the remaining headroom under the day's cap; a fully
 * warm domain (past the schedule) grants everything.
 */
export function warmupAllows(
  dayIndex: number,
  sentToday: number,
  requested: number,
): WarmupDecision {
  const capForDay = warmupCapForDay(dayIndex);
  if (capForDay === Number.POSITIVE_INFINITY) {
    return { allowed: true, capForDay, grantable: requested, reason: "domain warm — no cap" };
  }
  const headroom = Math.max(0, capForDay - sentToday);
  const grantable = Math.min(requested, headroom);
  return {
    allowed: grantable > 0,
    capForDay,
    grantable,
    reason:
      grantable >= requested
        ? `within warmup day ${dayIndex} cap (${sentToday}+${requested}/${capForDay})`
        : `warmup day ${dayIndex} cap: ${headroom} of ${requested} grantable (${sentToday}/${capForDay} sent)`,
  };
}
