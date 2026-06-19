/**
 * Deliverable delivery — the dispatcher (issue #295, ADR-0295).
 *
 * This is the seam `approvals/runtime.ts` (the `agent.deliverable` executor) delegates to AFTER the owner
 * approves a deliverable in the #13 queue. It is what finally SHIPS the draft: it resolves the structural
 * department, asks the pure {@link decideDelivery} brain whether and where to ship, routes to the channel
 * adapter, and records a durable, production-grounded receipt (premortem #200 §2/§3) tied to the #13
 * approval that authorized it.
 *
 * **Fail-closed safety invariant (#295):** nothing ships without an approval record. `ship` returns `null`
 * — falling back to the executor's pure acknowledgement (today's behavior) — whenever:
 *   - the approval request id is empty (no #13 row to tie the receipt to),
 *   - delivery is disabled for the workspace (default OFF, owner-workspace-first),
 *   - the department is not shippable, or its channel flag is off,
 *   - the draft is empty.
 * A real ship that FAILS its adapter records a `failed` receipt and throws {@link ActionExecutionError},
 * so the #13 request is marked `failed` — never a silent success.
 *
 * **Injection defense (#200 §6):** routing is decided purely from the structural department + flags (see
 * {@link decideDelivery}); the draft is opaque DATA (the content to ship), never parsed for routing.
 *
 * All IO is behind injected seams (department resolver, flags, adapters, receipts) so the dispatcher is
 * unit-testable with fakes and no DB.
 */

import { ActionExecutionError } from "../approvals/executor.js";
import {
  decideDelivery,
  type DeliveryChannel,
  type DeliveryFlags,
  type DeliveryReversibility,
} from "./decide.js";

/** A production-grounded outcome a channel adapter returns when it ships. */
export interface ChannelShipOutcome {
  /** The provider that handled it (`github_pages` | `dryrun` | ...). */
  provider: string;
  /** True ONLY when the ship reached a real external surface (a reachable URL / a real provider id). */
  live: boolean;
  /** The production-grounded external reference: a live URL, a post id, or a message id. */
  externalRef: string | null;
  detail?: Record<string, unknown>;
}

/** The content + context a channel adapter needs to ship one deliverable. */
export interface ChannelShipInput {
  workspaceId: string;
  sessionId: string | null;
  /** The briefed task (a title/subject hint). */
  task: string;
  /** The drafted content to ship. Opaque DATA — escaped/bounded by the adapter, never executed. */
  draft: string;
}

/** A narrow channel adapter: turns a deliverable's content into a real (or dry-run) ship + a receipt. */
export interface ChannelAdapter {
  readonly channel: DeliveryChannel;
  /** The provider kind this adapter ships through (for the receipt when the ship throws before returning). */
  readonly providerKind: string;
  ship(input: ChannelShipInput): Promise<ChannelShipOutcome>;
}

/** The durable receipt persisted for every shipped (or failed) deliverable — the proof (#200 §2). */
export interface DeliveryReceiptInput {
  workspaceId: string;
  /** THE proof that nothing ships without an approval record — the #13 request that authorized this ship. */
  approvalRequestId: string;
  sessionId: string | null;
  channel: DeliveryChannel;
  reversibility: DeliveryReversibility;
  provider: string;
  live: boolean;
  externalRef: string | null;
  status: "shipped" | "failed";
  detail: Record<string, unknown>;
}

export interface DeliveryReceiptStore {
  record(input: DeliveryReceiptInput): Promise<{ id: string }>;
}

/** What the dispatcher reads off the approved `agent.deliverable` payload (all defensive — may be absent). */
export interface DeliverablePayload {
  sessionId?: unknown;
  channelId?: unknown;
  task?: unknown;
  draft?: unknown;
}

export interface DeliveryShipContext {
  workspaceId: string;
  /** The #13 approval request id that authorized this ship. EMPTY ⇒ the dispatcher refuses to ship. */
  approvalRequestId: string;
}

export interface DeliveryShipResult {
  shipped: true;
  channel: DeliveryChannel;
  reversibility: DeliveryReversibility;
  provider: string;
  live: boolean;
  externalRef: string | null;
  receiptId: string;
}

export interface DeliveryDispatcher {
  /** Ship an approved deliverable, or return null when it is not eligible (→ acknowledgement fallback). */
  ship(payload: DeliverablePayload, ctx: DeliveryShipContext): Promise<DeliveryShipResult | null>;
}

/** A real, live ship — the head of the #386 attribution chain (artifact → exposure → …). */
export interface LiveShipEvent {
  workspaceId: string;
  /** The production-grounded external reference of the live ship (a live URL, a PR url, a post id). */
  externalRef: string;
  channel: DeliveryChannel;
  sessionId: string | null;
}

export interface DeliveryDispatcherDeps {
  /** Structural channel→department resolver (channelId → department key). Never reads the draft. */
  resolveDepartment(workspaceId: string, channelId: string | null): Promise<string | null>;
  /** The resolved ship flags for the workspace (default-OFF, owner-workspace-first). */
  resolveFlags(workspaceId: string): DeliveryFlags;
  /** One adapter per channel. */
  adapters: Record<DeliveryChannel, ChannelAdapter>;
  receipts: DeliveryReceiptStore;
  /**
   * OPTIONAL best-effort attribution hook (#386, ADR-0386): called AFTER a real live ship to record the
   * exposure (the head of the causal chain). It is wrapped in a try/catch that SWALLOWS errors — attribution
   * is observation, never on the critical path, and must NEVER break or fail a real ship. Undefined (the
   * default, attribution flag off) = prod byte-for-byte unchanged.
   */
  onLiveShip?: (e: LiveShipEvent) => Promise<void>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Build the dispatcher over its IO seams. See the module doc for the fail-closed ship invariant. */
export function createDeliveryDispatcher(deps: DeliveryDispatcherDeps): DeliveryDispatcher {
  return {
    async ship(payload, ctx) {
      // Fail-closed: no approval row → no ship. The executor only runs post-approval, but enforcing the
      // invariant here too means a receipt can NEVER exist without a #13 request to tie it to.
      if (!ctx.approvalRequestId) return null;

      const draft = str(payload.draft) ?? "";
      const channelId = str(payload.channelId);
      const department = await deps.resolveDepartment(ctx.workspaceId, channelId);
      const flags = deps.resolveFlags(ctx.workspaceId);
      const decision = decideDelivery({ department, flags, draft });
      if (!decision.ship) return null; // not eligible → acknowledgement (today's behavior).

      const adapter = deps.adapters[decision.channel];
      const input: ChannelShipInput = {
        workspaceId: ctx.workspaceId,
        sessionId: str(payload.sessionId),
        task: str(payload.task) ?? "",
        draft,
      };

      let outcome: ChannelShipOutcome;
      try {
        outcome = await adapter.ship(input);
      } catch (err) {
        // A failed ship is recorded (auditable, surfaces in the console) then re-thrown so the #13 request
        // is marked `failed` — never a silent send.
        await deps.receipts.record({
          workspaceId: ctx.workspaceId,
          approvalRequestId: ctx.approvalRequestId,
          sessionId: input.sessionId,
          channel: decision.channel,
          reversibility: decision.reversibility,
          provider: adapter.providerKind,
          live: false,
          externalRef: null,
          status: "failed",
          detail: { error: err instanceof Error ? err.message : String(err) },
        });
        throw err instanceof ActionExecutionError
          ? err
          : new ActionExecutionError(`delivery ${decision.channel} failed: ${String(err)}`);
      }

      const receipt = await deps.receipts.record({
        workspaceId: ctx.workspaceId,
        approvalRequestId: ctx.approvalRequestId,
        sessionId: input.sessionId,
        channel: decision.channel,
        reversibility: decision.reversibility,
        provider: outcome.provider,
        live: outcome.live,
        externalRef: outcome.externalRef,
        status: "shipped",
        detail: outcome.detail ?? {},
      });

      // #386: a REAL live ship is the head of the attribution chain. Best-effort, AFTER the receipt — a
      // dry-run (live:false) or a ship with no externalRef records no exposure, and a throwing hook is
      // swallowed so attribution can NEVER break or fail a real ship.
      if (outcome.live && outcome.externalRef) {
        try {
          await deps.onLiveShip?.({
            workspaceId: ctx.workspaceId,
            externalRef: outcome.externalRef,
            channel: decision.channel,
            sessionId: input.sessionId,
          });
        } catch {
          // swallow — attribution is observation, never on the ship's critical path.
        }
      }

      return {
        shipped: true,
        channel: decision.channel,
        reversibility: decision.reversibility,
        provider: outcome.provider,
        live: outcome.live,
        externalRef: outcome.externalRef,
        receiptId: receipt.id,
      };
    },
  };
}
