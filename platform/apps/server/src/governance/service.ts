/**
 * ApprovalService — the orchestrator behind the #13 approval gate (ADR-0013). It composes the
 * pure policy engine with three seams (store / executor / notifier) and an injectable clock, so the
 * whole request→decide→execute flow is unit-testable with no DB/Redis (mirrors the #25
 * SessionManager's deps-injected shape). The real wiring lives in `default.ts`.
 *
 * Discipline: the decision is the governance act and is the source of truth. Side-effects
 * (notification, execution) are best-effort — a failure is recorded/logged, never propagated, and
 * never turns an approved action back into a pending one.
 */
import {
  DEFAULT_POLICY,
  canResolve,
  evaluatePolicy,
  isExpired,
  type ActionKind,
  type ApprovalStatus,
  type GovernancePolicy,
  type SensitiveAction,
} from "./policy.js";
import type { ApprovalRequest } from "../db/repositories/approvals.js";

/** Persistence seam (real impl wraps the approvals repository; tests inject a fake). */
export interface ApprovalStore {
  create(input: {
    workspaceId: string;
    requestedByMemberId: string;
    actionKind: ActionKind;
    actionSummary: string;
    action: Record<string, unknown>;
    channelId?: string | null;
    status: ApprovalStatus;
    policyReason: string;
    expiresAt?: Date | null;
  }): Promise<ApprovalRequest>;
  getById(id: string, workspaceId: string): Promise<ApprovalRequest | undefined>;
  /** Resolve ONLY if still pending; returns undefined when the row was not pending (audit guard). */
  resolvePending(
    id: string,
    workspaceId: string,
    fields: {
      status: Extract<ApprovalStatus, "approved" | "rejected" | "expired">;
      decidedByMemberId?: string | null;
      decisionReason?: string | null;
      decidedAt: Date;
    },
  ): Promise<ApprovalRequest | undefined>;
  recordExecution(id: string, workspaceId: string, outcome: string, executedAt: Date): Promise<void>;
  getPolicy(workspaceId: string): Promise<GovernancePolicy>;
}

/** The action executor seam — what actually happens when an action is authorized. */
export interface ApprovalExecutor {
  execute(req: ApprovalRequest): Promise<{ outcome: string }>;
}

/** The "tell the humans" seam — fires when a request lands in `pending`. */
export interface ApprovalNotifier {
  notifyPending(req: ApprovalRequest): Promise<void>;
}

/** Injectable clock so TTL/expiry is deterministic in tests. */
export interface Clock {
  now(): Date;
}

export interface ApprovalServiceDeps {
  store: ApprovalStore;
  executor: ApprovalExecutor;
  notifier: ApprovalNotifier;
  clock?: Clock;
}

export interface RequestInput {
  workspaceId: string;
  requestedByMemberId: string;
  action: SensitiveAction;
}

/** Result of an approve/reject: the resolved request, or a code the route maps to an HTTP status. */
export type ResolveResult =
  | { ok: true; request: ApprovalRequest }
  | { ok: false; code: "not_found" | "expired" | "already_decided" };

/** Build an ApprovalService for a request/app logger (the route's injectable seam). */
export type ApprovalServiceFactory = (log: import("fastify").FastifyBaseLogger) => ApprovalService;

export class ApprovalService {
  private readonly clock: Clock;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  /**
   * Evaluate `action` against the workspace policy. If it is not gated, create an `auto_approved`
   * row and execute immediately. If it is gated, create a `pending` row (with a TTL), do NOT
   * execute, and notify the workspace's human approvers. Returns the persisted request.
   */
  async request(input: RequestInput): Promise<ApprovalRequest> {
    const { workspaceId, requestedByMemberId, action } = input;
    const policy = await this.deps.store.getPolicy(workspaceId).catch(() => DEFAULT_POLICY);
    const verdict = evaluatePolicy(action, policy);
    const now = this.clock.now();

    const base = {
      workspaceId,
      requestedByMemberId,
      actionKind: action.kind,
      actionSummary: action.summary,
      action: toDescriptor(action),
      channelId: action.channelId ?? null,
      policyReason: verdict.reason,
    };

    if (!verdict.required) {
      const row = await this.deps.store.create({ ...base, status: "auto_approved", expiresAt: null });
      await this.runExecutor(row);
      return (await this.deps.store.getById(row.id, workspaceId)) ?? row;
    }

    const expiresAt = new Date(now.getTime() + policy.defaultTtlMs);
    const row = await this.deps.store.create({ ...base, status: "pending", expiresAt });
    await this.safeNotify(row);
    return row;
  }

  /** Approve a pending request → execute the action. Human-only is enforced at the route. */
  async approve(
    id: string,
    workspaceId: string,
    deciderMemberId: string,
    reason?: string,
  ): Promise<ResolveResult> {
    return this.resolve(id, workspaceId, "approved", deciderMemberId, reason ?? null, true);
  }

  /** Reject a pending request → block the action (executor never runs). */
  async reject(
    id: string,
    workspaceId: string,
    deciderMemberId: string,
    reason?: string,
  ): Promise<ResolveResult> {
    return this.resolve(id, workspaceId, "rejected", deciderMemberId, reason ?? null, false);
  }

  private async resolve(
    id: string,
    workspaceId: string,
    decision: "approved" | "rejected",
    deciderMemberId: string,
    reason: string | null,
    execute: boolean,
  ): Promise<ResolveResult> {
    const existing = await this.deps.store.getById(id, workspaceId);
    if (!existing) return { ok: false, code: "not_found" };

    const now = this.clock.now();
    // Lazy expiry: a pending row past its TTL is finalized `expired` and refuses the decision.
    if (existing.status === "pending" && isExpired(existing.expiresAt, now)) {
      await this.deps.store.resolvePending(id, workspaceId, { status: "expired", decidedAt: now });
      return { ok: false, code: "expired" };
    }
    if (!canResolve(existing.status)) return { ok: false, code: "already_decided" };

    const resolved = await this.deps.store.resolvePending(id, workspaceId, {
      status: decision,
      decidedByMemberId: deciderMemberId,
      decisionReason: reason,
      decidedAt: now,
    });
    // The conditional update matched nothing → another decision won the race.
    if (!resolved) return { ok: false, code: "already_decided" };

    if (execute) {
      await this.runExecutor(resolved);
      return { ok: true, request: (await this.deps.store.getById(id, workspaceId)) ?? resolved };
    }
    return { ok: true, request: resolved };
  }

  /** Run the executor and record its outcome. Best-effort: failures are recorded, never thrown. */
  private async runExecutor(req: ApprovalRequest): Promise<void> {
    try {
      const { outcome } = await this.deps.executor.execute(req);
      await this.deps.store.recordExecution(req.id, req.workspaceId, outcome, this.clock.now());
    } catch (err) {
      await this.deps.store
        .recordExecution(req.id, req.workspaceId, `execution failed: ${errMessage(err)}`, this.clock.now())
        .catch(() => {
          /* swallow — the decision already stands */
        });
    }
  }

  private async safeNotify(req: ApprovalRequest): Promise<void> {
    try {
      await this.deps.notifier.notifyPending(req);
    } catch {
      /* best-effort: never fail the request because the notification fan-out hiccuped */
    }
  }
}

/** The persisted, opaque action descriptor (kind-specific fields kept for audit/replay). */
function toDescriptor(action: SensitiveAction): Record<string, unknown> {
  const d: Record<string, unknown> = { ...(action.metadata ?? {}) };
  if (action.amountCents !== undefined) d.amountCents = action.amountCents;
  if (action.currency !== undefined) d.currency = action.currency;
  if (action.channelId !== undefined) d.channelId = action.channelId;
  if (action.destination !== undefined) d.destination = action.destination;
  return d;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
