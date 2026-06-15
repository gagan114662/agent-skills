/**
 * The real-world tool surface services (#231). Deliberately split into TWO classes with DISJOINT
 * dependency sets — this split is the #223 injection-quarantine proof, identical in spirit to the
 * decision-maker:
 *
 *   - {@link RealWorldReadService} has ONLY a `reader`. It can browse/research and return DATA. It has
 *     no publish/send/spend seam, so a poisoned page it reads cannot become an action.
 *   - {@link RealWorldActuatorService} has the publish provider + the #13 gate, but NO `reader`. It
 *     never fetches web content, so injected text can only reach it as an explicit, human-reviewed #13
 *     payload — never silently from a read.
 *
 * Outward/irreversible actuation always routes through the #13 gate (recorded-only until a human
 * approves). The pure classification lives in {@link decideToolGate}.
 */

import type { ServiceKind } from "../onboarding/types.js";
import { decideToolGate } from "./decide.js";
import { REAL_WORLD_TOOL_NAMES } from "./types.js";
import type { RealWorldToolName, ToolGateDecision } from "./types.js";
import type { PublishProvider } from "./publish/provider.js";
import type { SitePrProvider } from "./publish/site-pr-provider.js";
import { decidePublishToIpop, type PublishToIpopRequest } from "./publish/site-pr-decide.js";

// ---------------------------------------------------------------------------------------------------
// #223 read surface — DATA only, zero actuation capability.
// ---------------------------------------------------------------------------------------------------

/** A quarantined web reader: returns DATA (a bounded excerpt), never an instruction. */
export interface QuarantinedWebReader {
  read(url: string): Promise<WebReadResult>;
}

export interface WebReadResult {
  url: string;
  ok: boolean;
  /** A sanitized, bounded quote of the fetched content — opaque DATA, never executed. */
  excerpt: string;
}

/** A reader that fetches nothing (the safe default until a live #174 browser reader is wired). */
export class NullWebReader implements QuarantinedWebReader {
  async read(url: string): Promise<WebReadResult> {
    return { url, ok: false, excerpt: "" };
  }
}

export interface RealWorldReadDeps {
  reader: QuarantinedWebReader;
}

export class RealWorldReadService {
  // The dependency surface IS the proof: a `reader` and nothing else. No publish/send/spend exists here,
  // so injected instructions in fetched text have no actuator to reach (#223).
  constructor(private readonly deps: RealWorldReadDeps) {}

  /** Browse one URL and return DATA. The result can inform a human/brief; it can never trigger a send. */
  async browse(url: string): Promise<WebReadResult> {
    return this.deps.reader.read(url);
  }

  /** Research several URLs and return their DATA. Same quarantine: read-only, no actuation. */
  async research(urls: string[]): Promise<WebReadResult[]> {
    return Promise.all(urls.map((u) => this.deps.reader.read(u)));
  }
}

// ---------------------------------------------------------------------------------------------------
// Actuator surface — routes outward actions through the #13 gate. No `reader` dep (the quarantine wall).
// ---------------------------------------------------------------------------------------------------

/** A durable receipt for every attempted real-world artifact (audit + console "real artifacts" signal). */
export interface ArtifactRecordInput {
  workspaceId: string;
  ventureId: string | null;
  tool: RealWorldToolName;
  url: string | null;
  provider: string;
  status: "blocked" | "pending_approval" | "published" | "failed";
  approvalRequestId: string | null;
  detail: string;
}

export interface ArtifactStore {
  record(input: ArtifactRecordInput): Promise<{ id: string }>;
}

/** The #13 approval seam (reuses the approvals policy + queue; recorded-only until a human approves). */
export interface ToolApprovalGate {
  requiresApproval(workspaceId: string): Promise<boolean>;
  submit(input: {
    workspaceId: string;
    requesterMemberId: string;
    summary: string;
    payload: Record<string, unknown>;
  }): Promise<{ id: string }>;
}

export interface RealWorldActuatorDeps {
  publish: PublishProvider;
  artifacts: ArtifactStore;
  approvals: ToolApprovalGate;
  /** The external account kinds connected for the workspace (#192) — gates account-dependent tools. */
  connectedAccounts: (workspaceId: string) => Promise<ReadonlySet<ServiceKind>>;
}

export interface PublishPageInput {
  workspaceId: string;
  ventureId?: string | null;
  slug: string;
  html: string;
  requesterMemberId: string;
  /**
   * True ONLY when a human has already approved this publish through #13 (i.e. the executor is running
   * post-approval). Never set it to skip the gate for un-approved work — the gate is always consulted.
   */
  approved?: boolean;
}

export type PublishPageResult =
  | { status: "blocked"; missingAccounts: ServiceKind[]; reason: string }
  | { status: "pending_approval"; approvalRequestId: string }
  | { status: "published"; url: string; providerId?: string }
  | { status: "failed"; error: string };

export class RealWorldActuatorService {
  constructor(private readonly deps: RealWorldActuatorDeps) {}

  /** The per-tool gate decisions for a workspace — what's ready, what's gated, what to connect first. */
  async availability(workspaceId: string): Promise<ToolGateDecision[]> {
    const connectedAccounts = await this.deps.connectedAccounts(workspaceId);
    return REAL_WORLD_TOOL_NAMES.map((name) => decideToolGate(name, { connectedAccounts }));
  }

  /**
   * Publish a page to a live URL through the `publish` tool. Always consults the #13 gate: if a hosting
   * account is missing the publish is BLOCKED (with what to connect); if approval is required and not yet
   * granted it PARKS a recorded-only #13 request; only an approved (or auto-approved) publish actually
   * pushes bytes via the provider. Every outcome writes a durable artifact receipt.
   */
  async publishPage(input: PublishPageInput): Promise<PublishPageResult> {
    const ventureId = input.ventureId ?? null;
    const connectedAccounts = await this.deps.connectedAccounts(input.workspaceId);
    const gate = decideToolGate("publish", { connectedAccounts });

    if (!gate.allowed) {
      await this.deps.artifacts.record({
        workspaceId: input.workspaceId,
        ventureId,
        tool: "publish",
        url: null,
        provider: this.deps.publish.kind,
        status: "blocked",
        approvalRequestId: null,
        detail: gate.reason,
      });
      return { status: "blocked", missingAccounts: gate.missingAccounts, reason: gate.reason };
    }

    // Outward action: park a #13 approval unless this is the post-approval execution.
    if (gate.requiresApproval && !input.approved) {
      const gated = await this.deps.approvals.requiresApproval(input.workspaceId);
      if (gated) {
        const approval = await this.deps.approvals.submit({
          workspaceId: input.workspaceId,
          requesterMemberId: input.requesterMemberId,
          summary: `Publish page "${input.slug}" to a live URL`,
          payload: { source: "realworld", tool: "publish", slug: input.slug, ventureId },
        });
        await this.deps.artifacts.record({
          workspaceId: input.workspaceId,
          ventureId,
          tool: "publish",
          url: null,
          provider: this.deps.publish.kind,
          status: "pending_approval",
          approvalRequestId: approval.id,
          detail: `parked #13 approval ${approval.id}`,
        });
        return { status: "pending_approval", approvalRequestId: approval.id };
      }
    }

    // Approved (or auto-approved): actually publish the bytes.
    const outcome = await this.deps.publish.publish({
      workspaceId: input.workspaceId,
      ventureId,
      slug: input.slug,
      html: input.html,
      onLog: () => undefined,
    });
    if (outcome.status !== "ready" || !outcome.url) {
      await this.deps.artifacts.record({
        workspaceId: input.workspaceId,
        ventureId,
        tool: "publish",
        url: null,
        provider: this.deps.publish.kind,
        status: "failed",
        approvalRequestId: null,
        detail: outcome.error ?? "publish failed",
      });
      return { status: "failed", error: outcome.error ?? "publish failed" };
    }
    await this.deps.artifacts.record({
      workspaceId: input.workspaceId,
      ventureId,
      tool: "publish",
      url: outcome.url,
      provider: this.deps.publish.kind,
      status: "published",
      approvalRequestId: null,
      detail: `published via ${this.deps.publish.kind}`,
    });
    return { status: "published", url: outcome.url, providerId: outcome.providerId };
  }
}

// ---------------------------------------------------------------------------------------------------
// #250 self-publish to ipop.ai — AUTONOMOUS. ipop owns the site repo, so committing content + opening
// a PR is money-free and reversible; per the money-only approval policy (#243) it carries NO #13 gate.
// It is an actuator, but a constrained one: it can only ever open a PR (a review surface) against ipop's
// own repo via the {@link SitePrProvider} — it has no send/spend/deploy seam, so even a poisoned web read
// folded into the content can do no more than draft a PR a human still merges. Deliberately a separate
// service from {@link RealWorldActuatorService} (which is #13-gated): the dependency surface is the proof.
// ---------------------------------------------------------------------------------------------------

export interface IpopSitePublishDeps {
  provider: SitePrProvider;
  /** Repo dir new content files are committed under (e.g. `content/blog`). */
  contentDir: string;
  /** Durable receipt sink (optional — absent ⇒ no artifact row, behavior otherwise unchanged). */
  artifacts?: ArtifactStore;
}

export type IpopSitePublishResult =
  | { status: "rejected"; reason: string }
  | { status: "published"; prUrl: string; branch: string; path: string; providerId?: string }
  | { status: "failed"; error: string };

export class IpopSitePublishService {
  constructor(private readonly deps: IpopSitePublishDeps) {}

  /**
   * Plan + open a PR for a content file against ipop's site repo. No approval gate — opening a PR is
   * autonomous (#243 money-only). Rejects an invalid request (empty/ unslugglable) BEFORE any network
   * call, and records a durable receipt for every terminal outcome.
   */
  async publish(input: {
    workspaceId: string;
    ventureId?: string | null;
    request: PublishToIpopRequest;
  }): Promise<IpopSitePublishResult> {
    const ventureId = input.ventureId ?? null;
    const plan = decidePublishToIpop(input.request, { contentDir: this.deps.contentDir });
    if (!plan.ok) {
      await this.record(input.workspaceId, ventureId, null, "failed", plan.reason);
      return { status: "rejected", reason: plan.reason };
    }

    const outcome = await this.deps.provider.openPr({
      workspaceId: input.workspaceId,
      ventureId,
      path: plan.path,
      content: plan.content,
      title: plan.title,
      body: plan.body,
      branch: plan.branch,
      onLog: () => undefined,
    });

    if (outcome.status !== "ready" || !outcome.prUrl) {
      await this.record(input.workspaceId, ventureId, null, "failed", outcome.error ?? "publish failed");
      return { status: "failed", error: outcome.error ?? "publish failed" };
    }
    await this.record(input.workspaceId, ventureId, outcome.prUrl, "published", `PR via ${this.deps.provider.kind}`);
    return {
      status: "published",
      prUrl: outcome.prUrl,
      branch: outcome.branch ?? plan.branch,
      path: plan.path,
      providerId: outcome.providerId,
    };
  }

  private async record(
    workspaceId: string,
    ventureId: string | null,
    url: string | null,
    status: ArtifactRecordInput["status"],
    detail: string,
  ): Promise<void> {
    if (!this.deps.artifacts) return;
    await this.deps.artifacts
      .record({
        workspaceId,
        ventureId,
        tool: "publish_site",
        url,
        provider: this.deps.provider.kind,
        status,
        approvalRequestId: null,
        detail,
      })
      .catch(() => undefined); // a receipt hiccup must never fail an otherwise-successful publish
  }
}
