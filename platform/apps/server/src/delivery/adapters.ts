/**
 * Deliverable delivery — channel adapters (issue #295, ADR-0295).
 *
 * Each adapter turns a deliverable's drafted content into a real (or dry-run) ship through an EXISTING
 * provider seam — no new actuator is invented:
 *
 *  - {@link PublishChannelAdapter} reuses the #231 {@link PublishProvider}: it wraps the draft into a
 *    standalone HTML page and publishes it to a live, reachable URL, then HEAD-checks the URL to PROVE it
 *    is live (premortem #200 §3). With the dry-run provider (the default) the page is not reachable and
 *    `live:false`; with `github_pages` connected it is a genuine live URL.
 *  - {@link SocialChannelAdapter} / {@link EmailChannelAdapter} reuse the #189 acquisition providers. These
 *    default to DRY-RUN (no network egress, `live:false`): a real X/LinkedIn or ESP adapter is a deliberate
 *    future step behind connected credentials (out of scope for #295 — "no credentials"). Email ships with
 *    NO recipients (a content draft carries none), so it can never reach a real inbox here.
 *
 * The draft is opaque DATA: the publish adapter HTML-escapes it so injected markup in the draft renders as
 * inert text, never executable content on the published page.
 */

import { ActionExecutionError } from "../approvals/executor.js";
import type { PublishProvider } from "../realworld/publish/provider.js";
import type { EspProvider, SocialProvider } from "../acquisition/providers.js";
import type { ChannelAdapter, ChannelShipInput, ChannelShipOutcome } from "./dispatcher.js";

/** A DNS/URL-safe slug derived from the task (or a fallback), bounded so it is always a valid repo/path part. */
export function slugify(task: string, fallback = "deliverable"): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

/** Escape the five HTML-significant characters so a draft renders as inert text, never executable markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a (untrusted) draft into a minimal, standalone HTML document with the draft escaped as text. */
export function draftToHtml(title: string, draft: string): string {
  const safeTitle = escapeHtml(title || "Deliverable");
  const safeBody = escapeHtml(draft).replace(/\n/g, "<br>\n");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${safeTitle}</title></head><body><main><h1>${safeTitle}</h1>` +
    `<article>${safeBody}</article></main></body></html>`
  );
}

/** Publish a deliverable to a live, reachable URL via the #231 publish provider, proving it with a HEAD check. */
export class PublishChannelAdapter implements ChannelAdapter {
  readonly channel = "publish" as const;
  readonly providerKind: string;
  constructor(private readonly provider: PublishProvider) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const slug = slugify(input.task);
    const html = draftToHtml(input.task, input.draft);
    const outcome = await this.provider.publish({
      workspaceId: input.workspaceId,
      slug,
      html,
      onLog: () => undefined,
    });
    if (outcome.status !== "ready" || !outcome.url) {
      throw new ActionExecutionError(outcome.error ?? "publish failed");
    }
    // Production-grounded verification (#200 §3): the URL is only "live" if it actually answers.
    const health = await this.provider.healthCheck(outcome.url);
    return {
      provider: this.provider.kind,
      live: health.ok,
      externalRef: outcome.url,
      detail: { slug, providerId: outcome.providerId ?? null, healthStatus: health.status },
    };
  }
}

/** Post a deliverable to social via the #189 social provider (dry-run by default — no real network). */
export class SocialChannelAdapter implements ChannelAdapter {
  readonly channel = "social" as const;
  readonly providerKind: string;
  constructor(private readonly provider: SocialProvider) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const outcome = await this.provider.publish({
      workspaceId: input.workspaceId,
      ideaId: null,
      // The network is a constant default (NOT parsed from the draft) — injection cannot retarget it.
      network: "social",
      text: input.draft,
    });
    if (outcome.status !== "sent") {
      throw new ActionExecutionError(`social post failed via ${outcome.provider}`);
    }
    return {
      provider: outcome.provider,
      // Only a non-dry-run provider is a genuine live post.
      live: outcome.provider !== "dryrun",
      externalRef: outcome.externalId,
      detail: { ...outcome.detail },
    };
  }
}

/** Send a deliverable via the #189 ESP (dry-run by default; NO recipients — a content draft carries none). */
export class EmailChannelAdapter implements ChannelAdapter {
  readonly channel = "email" as const;
  readonly providerKind: string;
  constructor(private readonly provider: EspProvider) {
    this.providerKind = provider.kind;
  }
  async ship(input: ChannelShipInput): Promise<ChannelShipOutcome> {
    const outcome = await this.provider.send({
      workspaceId: input.workspaceId,
      ideaId: null,
      subject: input.task || "Deliverable",
      body: input.draft,
      // A content draft carries no recipient list; we NEVER invent real addresses (#295 hard constraint).
      recipients: [],
    });
    if (outcome.status !== "sent") {
      throw new ActionExecutionError(`email send failed via ${outcome.provider}`);
    }
    return {
      // No recipients + dry-run ⇒ nothing reached a real inbox; never claim a live send here.
      provider: outcome.provider,
      live: false,
      externalRef: outcome.externalId,
      detail: { ...outcome.detail, recipientCount: 0 },
    };
  }
}
