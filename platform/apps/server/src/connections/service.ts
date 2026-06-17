/**
 * The connect-once SERVICE (#258 Stage 2, ADR-0258) — the IO orchestrator behind the shared connect seam.
 * It owns **no new authority**: the pure {@link decideConnectStart} makes the offer/gate decision, and when
 * the live flow is in scope the service parks a PENDING `connection.connect_account` #13 request the owner
 * approves (or not). There is NO autonomous-connect path — the live connect ALWAYS pauses for the owner.
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos in
 * `default.ts` (mirrors `skillopt/service.ts`, `outreach/service.ts`). Fail-closed: when the live flow is
 * disabled / out of scope / unwired for a workspace, the service returns the honest `coming_soon` (the #258
 * Stage 1 behavior) and parks nothing — default OFF, owner-workspace-first.
 */
import type { ConnectionDescriptor } from "./registry.js";
import type { ConnectOnceCaps } from "./caps.js";
import type { ConnectProvider } from "./provider.js";
import { decideConnectStart, type ConnectStartOutcome } from "./connect.js";

/** Identity a connect is attributed to: the workspace + the member the parked #13 request is requested as. */
export interface ConnectIdentity {
  workspaceId: string;
  requesterMemberId: string;
}

export interface ConnectOnceDeps {
  /** Resolve the per-workspace caps (the live-flow flag + owner-first). */
  caps(workspaceId: string): ConnectOnceCaps;
  /** The provider wired for a connection id (its `live` flag drives the offer; dry-run when unwired). */
  provider(connectionId: string): ConnectProvider;
  /** Park the live connect as a PENDING `connection.connect_account` #13 request; returns the request id. */
  park(input: {
    workspaceId: string;
    requesterMemberId: string;
    descriptor: ConnectionDescriptor;
  }): Promise<{ id: string }>;
}

/** The outcome the route renders. `coming_soon` carries the reason; `pending_approval` carries the #13 id. */
export type StartConnectResult =
  | { status: "coming_soon"; reason: string }
  | { status: "pending_approval"; requestId: string };

export class ConnectOnceService {
  constructor(private readonly deps: ConnectOnceDeps) {}

  /**
   * Start a customer-OAuth connect. Returns the honest `coming_soon` unless the live flow is in scope for
   * the workspace AND a live provider is wired AND `descriptor` is an OAuth connector — in which case it
   * parks a PENDING owner approval and returns its request id. The owner must approve before any credential
   * is minted (the connect-once always-gate); the live mint/seal behind the gate is the per-department
   * follow-up (#265/#268/#269/#272).
   */
  async startConnect(
    identity: ConnectIdentity,
    descriptor: ConnectionDescriptor | undefined,
  ): Promise<StartConnectResult> {
    const caps = this.deps.caps(identity.workspaceId);
    const provider = descriptor ? this.deps.provider(descriptor.id) : undefined;
    const decision: ConnectStartOutcome = decideConnectStart({
      descriptor,
      caps,
      workspaceId: identity.workspaceId,
      liveProviderConfigured: provider?.live ?? false,
    });
    if (decision.outcome === "coming_soon") {
      return { status: "coming_soon", reason: decision.reason };
    }
    // In scope + live + OAuth — park the owner approval. `descriptor` is defined here (decideConnectStart
    // returns `coming_soon` for an undefined/non-OAuth descriptor), so the non-null assertion is safe.
    const req = await this.deps.park({
      workspaceId: identity.workspaceId,
      requesterMemberId: identity.requesterMemberId,
      descriptor: descriptor!,
    });
    return { status: "pending_approval", requestId: req.id };
  }
}
