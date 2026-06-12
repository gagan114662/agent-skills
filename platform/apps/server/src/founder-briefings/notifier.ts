import type { PagerTransport } from "../reliability/pager/transport.js";

/**
 * Founder-briefing delivery (#173, ADR-0173). Reuses the #148 email-first {@link PagerTransport} seam to
 * push the digest to the resolved workspace owner, AND an optional {@link SlackDeliverer} (#170). Slack
 * is **feature-gated**: the default {@link NoopSlackDeliverer} reports `not_connected`, so this layer
 * never depends on #170 — when #170 lands it injects a real Slack DM deliverer with no change here. The
 * email channel is always available (the #148 log transport sends nowhere in CI/privacy mode).
 *
 * Delivery NEVER throws — a transport error is captured as a per-channel result so the audit always
 * records the attempt (mirrors the #148 `PagerService` "always audit" rule).
 */

export type DigestKind = "daily" | "weekly";

export interface BriefingDelivery {
  workspaceId: string;
  kind: DigestKind;
  subject: string;
  body: string;
}

/** One channel's outcome (audited per send). */
export interface ChannelResult {
  channel: "email" | "slack";
  delivered: boolean;
  /** `delivered` | `no_owner` | `transport_error` | `not_connected` | a deliverer-specific reason. */
  reason: string;
}

export interface DeliveryResult {
  channels: ChannelResult[];
  /** True when at least one channel delivered. */
  anyDelivered: boolean;
}

export interface BriefingNotifier {
  deliver(input: BriefingDelivery): Promise<DeliveryResult>;
}

/** The owner contact resolution seam (the orchestrator wires #148 `getWorkspaceOwnerContact`). */
export interface OwnerContactResolver {
  resolve(workspaceId: string): Promise<{ email: string } | null>;
}

/** The optional Slack DM channel (#170). The default is a no-op until Slack is connected. */
export interface SlackDeliverer {
  deliver(input: BriefingDelivery & { ownerEmail: string | null }): Promise<ChannelResult>;
}

/** Default Slack channel: not connected (the #170 adapter replaces this when it lands). */
export class NoopSlackDeliverer implements SlackDeliverer {
  async deliver(): Promise<ChannelResult> {
    return { channel: "slack", delivered: false, reason: "not_connected" };
  }
}

export interface MultiChannelNotifierDeps {
  ownerContact: OwnerContactResolver;
  /** The #148 email-first transport (log transport in CI / privacy mode). */
  transport: PagerTransport;
  /** The optional Slack DM channel (#170). Absent ⇒ {@link NoopSlackDeliverer}. */
  slack?: SlackDeliverer;
}

/**
 * The default notifier: email (via the #148 transport to the resolved owner) + an optional Slack DM. A
 * workspace with no verified owner is audited `no_owner` on the email channel and the digest is dropped
 * for that channel — never throws.
 */
export class MultiChannelBriefingNotifier implements BriefingNotifier {
  private readonly slack: SlackDeliverer;
  constructor(private readonly deps: MultiChannelNotifierDeps) {
    this.slack = deps.slack ?? new NoopSlackDeliverer();
  }

  async deliver(input: BriefingDelivery): Promise<DeliveryResult> {
    const owner = await this.deps.ownerContact.resolve(input.workspaceId);

    let email: ChannelResult;
    if (!owner) {
      email = { channel: "email", delivered: false, reason: "no_owner" };
    } else {
      try {
        await this.deps.transport.send({ to: owner.email, subject: input.subject, body: input.body });
        email = { channel: "email", delivered: true, reason: "delivered" };
      } catch {
        email = { channel: "email", delivered: false, reason: "transport_error" };
      }
    }

    let slack: ChannelResult;
    try {
      slack = await this.slack.deliver({ ...input, ownerEmail: owner?.email ?? null });
    } catch {
      slack = { channel: "slack", delivered: false, reason: "transport_error" };
    }

    const channels = [email, slack];
    return { channels, anyDelivered: channels.some((c) => c.delivered) };
  }
}
