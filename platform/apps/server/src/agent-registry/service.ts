/**
 * The Agent Registry service (#282, ADR-0282) — the IO orchestrator that lists the fleet's agents for a
 * workspace and runs governed, observable agent-to-agent (A2A) calls. It owns **no new launch authority**:
 * the pure {@link decideA2ACall} governs the call, and an allowed call is dispatched through the EXISTING
 * launch seam (the #235 brief / #123 @mention path → #59 SubagentService → #96 venture gate → #71
 * admission), injected as `dispatch`. The observable call path is the {@link A2ACallRecord} this returns
 * plus the durable `marketing_tasks` launch receipt the dispatch already writes (read back by the #-audit
 * feed) — receipts-as-observability, no new store.
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos
 * in `default.ts` (mirrors `discovery/service.ts`).
 */
import { buildAgentRegistry, type AgentRegistry, type RegistryEntry } from "./registry.js";
import { decideA2ACall } from "./a2a.js";
import type { AgentRegistryCaps } from "./caps.js";
import { isOwnerWorkspace } from "./caps.js";
import { isFleetHandle } from "./contract.js";
import type { A2ACallDecision, A2ACallRecord } from "./types.js";

export interface AgentRegistryIdentity {
  workspaceId: string;
  memberId: string;
}

/** The result of dispatching an allowed A2A call down the existing launch seam. */
export type DispatchResult =
  | { ok: true; channelId: string; messageId: string; sessionId: string | null }
  | { ok: false; code: number; error: string };

export interface AgentRegistryDeps {
  /** Resolve the per-workspace caps (the feature flag + owner-first + depth cap). */
  caps(workspaceId: string): AgentRegistryCaps;
  /** The fleet @handles seeded in the workspace (from `listPersonas`, filtered to fleet handles). */
  listPresentHandles(workspaceId: string): Promise<string[]>;
  /**
   * Dispatch an allowed call down the EXISTING launch seam: post `@target <task>` and launch the target
   * agent. The implementation reuses the #235 brief front door (no new execution path). The task is the
   * already-sanitized DATA from the decision.
   */
  dispatch(
    identity: AgentRegistryIdentity,
    input: { callerHandle: string; targetHandle: string; task: string },
  ): Promise<DispatchResult>;
  /**
   * Optional observability sink for the call record (defense-in-depth). The durable receipt is the
   * `marketing_tasks` row the dispatch writes; this is an extra hook (e.g. structured log) for the path.
   */
  observe?(record: A2ACallRecord): Promise<void> | void;
}

export interface ListAgentsResult {
  /** Whether A2A calls are enabled for this workspace (the catalog lists regardless). */
  enabled: boolean;
  entries: RegistryEntry[];
}

export type CallResult =
  | { ok: true; decision: A2ACallDecision; dispatch: DispatchResult }
  | { ok: false; code: number; error: string; decision?: A2ACallDecision };

export class AgentRegistryService {
  constructor(private readonly deps: AgentRegistryDeps) {}

  /** Build the workspace registry (read-only). Always works — when the flag is off, every entry is disabled. */
  private async registryFor(workspaceId: string): Promise<{ registry: AgentRegistry; caps: AgentRegistryCaps }> {
    const caps = this.deps.caps(workspaceId);
    const presentHandles = (await this.deps.listPresentHandles(workspaceId)).filter(isFleetHandle);
    const registry = buildAgentRegistry({
      presentHandles,
      registryEnabled: caps.enabled,
      isOwnerWorkspace: isOwnerWorkspace(caps, workspaceId),
      ownerWorkspaceOnly: caps.ownerWorkspaceOnly,
    });
    return { registry, caps };
  }

  /** List every fleet agent's contract with its present/enabled flags for this workspace. Read-only. */
  async listAgents(identity: AgentRegistryIdentity): Promise<ListAgentsResult> {
    const { registry } = await this.registryFor(identity.workspaceId);
    return { enabled: registry.entries.some((e) => e.enabled), entries: registry.entries };
  }

  /**
   * Run a governed, observable A2A call: caller → target for a capability. When the feature is disabled
   * the call is a 409 (the catalog still lists). An allowed call is dispatched down the existing launch
   * seam; a denied call returns 403 with the observable decision record so the refusal is never invisible.
   */
  async call(
    identity: AgentRegistryIdentity,
    input: {
      callerHandle: string;
      targetHandle: string;
      capability: string;
      task: string;
      callChain?: readonly string[];
    },
  ): Promise<CallResult> {
    const { registry, caps } = await this.registryFor(identity.workspaceId);
    if (!caps.enabled) {
      return { ok: false, code: 409, error: "agent-to-agent calls are not enabled for this workspace" };
    }

    const decision = decideA2ACall(
      {
        callerHandle: input.callerHandle.trim().replace(/^@/, "").toLowerCase(),
        targetHandle: input.targetHandle.trim().replace(/^@/, "").toLowerCase(),
        capability: input.capability.trim(),
        task: input.task,
        callChain: input.callChain,
        maxDepth: caps.maxCallDepth,
      },
      registry,
    );

    // Record the hop (allowed or denied) for observability — never blocks the decision.
    if (this.deps.observe) await this.deps.observe(decision.record);

    if (!decision.allowed) {
      return { ok: false, code: 403, error: decision.record.reason, decision };
    }

    const dispatch = await this.deps.dispatch(identity, {
      callerHandle: decision.record.callerHandle,
      targetHandle: decision.record.targetHandle,
      task: decision.record.task,
    });
    if (!dispatch.ok) {
      return { ok: false, code: dispatch.code, error: dispatch.error, decision };
    }
    return { ok: true, decision, dispatch };
  }
}
