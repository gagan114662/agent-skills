/**
 * Pluggable pager transport for the reliability surface (#148, ADR-0148). Decouples *deciding* to page
 * (`decidePage`) from *delivering* it. **Email-first**: the default is a structured-log transport that
 * sends nowhere (so CI/tests need no SMTP), and an `EmailPagerTransport` activates when an SMTP sender
 * is configured. Push/SMS are future transports behind the same seam. Mirrors the #8 notifications
 * transport (Noop + Webhook) — no new dependency; the actual mail/SMS client is an injected function.
 */
import type { SessionLogger } from "../../runtime/manager.js";
import { egressAllowed } from "../../config/egress.js";

export interface PagerMessage {
  to: string;
  subject: string;
  body: string;
}

export interface PagerTransport {
  send(msg: PagerMessage): Promise<void>;
}

/** Default transport: records the page in the log, forwards nowhere. Safe for CI + un-configured deploys. */
export class LogPagerTransport implements PagerTransport {
  constructor(private readonly logger: SessionLogger) {}
  async send(msg: PagerMessage): Promise<void> {
    this.logger.warn({ to: msg.to, subject: msg.subject, transport: "log" }, "reliability page (log transport)");
  }
}

/** The injected mail sender — kept abstract so the transport is unit-testable with no SMTP dependency. */
export type SendMail = (msg: PagerMessage) => Promise<void>;

/** Forwards each page as an email via an injected sender (the SMTP client is supplied at wiring time). */
export class EmailPagerTransport implements PagerTransport {
  constructor(private readonly sendMail: SendMail) {}
  async send(msg: PagerMessage): Promise<void> {
    await this.sendMail(msg);
  }
}

/**
 * Pick the transport for a deployment: the email transport when an SMTP sender is configured AND
 * off-platform egress is allowed (#58 data-privacy mode forces the no-op log transport); else the log
 * transport. Email-first, but never sends in CI/privacy mode.
 */
export function selectPagerTransport(opts: {
  logger: SessionLogger;
  sendMail?: SendMail;
  dataPrivacyMode?: boolean;
}): PagerTransport {
  if (opts.sendMail && egressAllowed({ dataPrivacyMode: opts.dataPrivacyMode ?? false })) {
    return new EmailPagerTransport(opts.sendMail);
  }
  return new LogPagerTransport(opts.logger);
}
