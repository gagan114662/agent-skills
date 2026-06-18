/**
 * The Agent Garden service (#284, ADR-0284) — the IO orchestrator behind the `/me/garden` surface. It owns
 * **no new authority**: the pure {@link decideGardenEnable}/{@link decideGardenDisable} govern each action,
 * and an `external_send` enable parks a PENDING `garden.enable_agent` #13 request the owner approves (or
 * not) — there is NO autonomous-enable path for that tier. Read-only / internal-draft agents enable
 * directly (reversible, money-free). The catalog it lists comes straight from the #282 registry contracts.
 *
 * Every side effect is one injected seam, so the service runs against fakes in unit tests and real repos in
 * `default.ts` (mirrors `agent-registry/service.ts`, `connections/service.ts`). Fail-closed: an unknown
 * handle 404s; an out-of-scope workspace (flag off / not the owner) 409s and persists nothing.
 */
import { agentContracts, contractForHandle, type AgentContract } from "../agent-registry/contract.js";
import type { GardenCaps } from "./caps.js";
import { isGardenManageInScope } from "./caps.js";
import { decideGardenEnable, decideGardenDisable, projectGardenView } from "./decide.js";
import type { GardenAgentState, GardenView } from "./types.js";

export interface GardenIdentity {
  workspaceId: string;
  memberId: string;
}

/** The persisted per-(workspace, agent) enable state seam. An absent handle reads as `disabled` upstream. */
export interface GardenStateStore {
  getStates(workspaceId: string): Promise<Record<string, GardenAgentState>>;
  setState(workspaceId: string, handle: string, state: GardenAgentState): Promise<void>;
}

export interface GardenDeps {
  /** Resolve the per-workspace caps (the manage flag + owner-first). */
  caps(workspaceId: string): GardenCaps;
  /** The fleet @handles seeded in the workspace (from `listPersonas`) — the production-grounded fact. */
  listPresentHandles(workspaceId: string): Promise<string[]>;
  /** Read the persisted enable states for the workspace. */
  getStates(workspaceId: string): Promise<Record<string, GardenAgentState>>;
  /** Persist one agent's enable state (idempotent upsert). */
  setState(workspaceId: string, handle: string, state: GardenAgentState): Promise<void>;
  /**
   * Park the `external_send` enable as a PENDING `garden.enable_agent` #13 request; returns the request id.
   * The `summary` the owner reads is built structurally from the already-validated handle/displayName
   * (injection defense), never by interpolating raw metadata.
   */
  park(input: {
    workspaceId: string;
    requesterMemberId: string;
    contract: AgentContract;
  }): Promise<{ id: string }>;
}

/** The outcome of an enable: enabled directly, or parked for owner approval (with the #13 request id). */
export type GardenEnableResult =
  | { ok: true; outcome: "enabled"; view: GardenView }
  | { ok: true; outcome: "pending_approval"; requestId: string; view: GardenView }
  | { ok: false; code: number; error: string };

export type GardenDisableResult =
  | { ok: true; outcome: "disabled"; view: GardenView }
  | { ok: false; code: number; error: string };

/** Normalize a caller-supplied handle: trim, drop a leading `@`, lowercase. Pure. */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export class GardenService {
  constructor(private readonly deps: GardenDeps) {}

  /** The contracts the Garden catalogs — the full #282 registry, in blueprint order. */
  private contracts(): AgentContract[] {
    return agentContracts();
  }

  private async viewFor(workspaceId: string): Promise<GardenView> {
    const caps = this.deps.caps(workspaceId);
    const [presentHandles, states] = await Promise.all([
      this.deps.listPresentHandles(workspaceId),
      this.deps.getStates(workspaceId),
    ]);
    return projectGardenView({
      contracts: this.contracts(),
      presentHandles,
      states,
      canManage: isGardenManageInScope(caps, workspaceId),
    });
  }

  /** List every fleet agent's (sanitized) contract + this workspace's enable state. Read-only; always works. */
  async list(identity: GardenIdentity): Promise<GardenView> {
    return this.viewFor(identity.workspaceId);
  }

  /**
   * Enable one agent. A `read_only`/`internal_draft` agent flips to `enabled` directly; an `external_send`
   * agent parks an owner approval and flips to `pending_approval`. Fail-closed: unknown handle → 404,
   * out-of-scope workspace → 409 (nothing persisted).
   */
  async enable(identity: GardenIdentity, rawHandle: string): Promise<GardenEnableResult> {
    const handle = normalizeHandle(rawHandle);
    const contract = contractForHandle(handle);
    const manageInScope = isGardenManageInScope(this.deps.caps(identity.workspaceId), identity.workspaceId);
    const decision = decideGardenEnable({ contract, manageInScope });

    if (decision.outcome === "refused") {
      return { ok: false, code: contract ? 409 : 404, error: decision.reason };
    }

    // `contract` is defined past a non-refused decision (refused covers the undefined case).
    const target = contract!;
    if (decision.outcome === "needs_approval") {
      const req = await this.deps.park({
        workspaceId: identity.workspaceId,
        requesterMemberId: identity.memberId,
        contract: target,
      });
      await this.deps.setState(identity.workspaceId, target.handle, "pending_approval");
      return {
        ok: true,
        outcome: "pending_approval",
        requestId: req.id,
        view: await this.viewFor(identity.workspaceId),
      };
    }

    await this.deps.setState(identity.workspaceId, target.handle, "enabled");
    return { ok: true, outcome: "enabled", view: await this.viewFor(identity.workspaceId) };
  }

  /** Disable one agent (always immediate — a disable only reduces blast radius, so it is never gated). */
  async disable(identity: GardenIdentity, rawHandle: string): Promise<GardenDisableResult> {
    const handle = normalizeHandle(rawHandle);
    const contract = contractForHandle(handle);
    const manageInScope = isGardenManageInScope(this.deps.caps(identity.workspaceId), identity.workspaceId);
    const decision = decideGardenDisable({ contract, manageInScope });

    if (decision.outcome === "refused") {
      return { ok: false, code: contract ? 409 : 404, error: decision.reason };
    }
    await this.deps.setState(identity.workspaceId, contract!.handle, "disabled");
    return { ok: true, outcome: "disabled", view: await this.viewFor(identity.workspaceId) };
  }
}
