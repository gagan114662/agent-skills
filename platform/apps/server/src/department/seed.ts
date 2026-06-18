import type { DepartmentPersona } from "./blueprint.js";
import { DEPARTMENT_DRAFT_TOOLS } from "./blueprint.js";

/**
 * Seed the named department team for a workspace (#371, ADR-0371) — **pure** orchestration over injected
 * seams (no DB/IO here), so it runs in the no-DB unit job and `department/default.ts` binds the real repos.
 *
 * Each teammate is minted as an agent member + persona reusing the EXISTING #59 persona path (the same
 * `createPersona` seam the #123 marketing seed uses), so the personas are first-class @-mentionable members
 * and flow through every existing path. Identity / display only: each carries the read/draft tool ceiling
 * and **no send/spend tool** — no new action path (#200).
 *
 * Idempotency: a teammate is matched by @handle, so re-running never duplicates a persona or rotates a
 * token. Reversible: a seeded persona is deactivated through the existing #9 `deactivate` path. A persona
 * whose handle coincides with an already-seeded fleet agent (e.g. `scout`) is reused, never duplicated.
 */
export interface DepartmentSeedDeps {
  /** A persona by @handle in this workspace, or undefined (the idempotency key). */
  getPersonaByHandle(workspaceId: string, handle: string): Promise<{ id: string; agentMemberId: string } | undefined>;
  /** Mint a persona (agent member + token + identity prompt + draft-only tool ceiling). */
  createPersona(spec: {
    workspaceId: string;
    name: string;
    systemPrompt: string;
    allowedTools: string[];
    model: string | null;
    createdByMemberId: string;
  }): Promise<{ id: string; agentMemberId: string }>;
}

/** One seeded teammate: its persona id + agent member id, its roster metadata, and whether it was created. */
export interface SeededDepartmentAgent {
  id: string;
  agentMemberId: string;
  handle: string;
  displayName: string;
  department: string;
  role: string;
  color: string;
  lead: boolean;
  /** True only on the seed that first created this persona (false on a re-seed reuse). */
  created: boolean;
}

export interface DepartmentSeedInput {
  workspaceId: string;
  createdByMemberId: string;
  /** The effective roster to seed (from {@link resolveDepartmentCaps}). */
  roster: readonly DepartmentPersona[];
}

export interface DepartmentSeedResult {
  agents: SeededDepartmentAgent[];
  /** How many personas this seed actually created (0 on a fully idempotent re-seed). */
  createdCount: number;
}

async function ensurePersona(
  deps: DepartmentSeedDeps,
  workspaceId: string,
  createdByMemberId: string,
  p: DepartmentPersona,
): Promise<SeededDepartmentAgent> {
  const existing = await deps.getPersonaByHandle(workspaceId, p.handle);
  if (existing) {
    return {
      id: existing.id,
      agentMemberId: existing.agentMemberId,
      handle: p.handle,
      displayName: p.displayName,
      department: p.department,
      role: p.role,
      color: p.color,
      lead: p.lead,
      created: false,
    };
  }
  const created = await deps.createPersona({
    workspaceId,
    name: p.handle,
    systemPrompt: p.systemPrompt,
    allowedTools: [...DEPARTMENT_DRAFT_TOOLS],
    model: null,
    createdByMemberId,
  });
  return {
    id: created.id,
    agentMemberId: created.agentMemberId,
    handle: p.handle,
    displayName: p.displayName,
    department: p.department,
    role: p.role,
    color: p.color,
    lead: p.lead,
    created: true,
  };
}

/**
 * Seed (or idempotently re-confirm) the department roster. Each teammate is ensured by handle; the result
 * lists every teammate with its role/color and a `created` flag. No channels, no launches, no sends — the
 * team is identity/display only; real work still routes through the @mention / #13 paths.
 */
export async function seedDepartment(
  input: DepartmentSeedInput,
  deps: DepartmentSeedDeps,
): Promise<DepartmentSeedResult> {
  const agents: SeededDepartmentAgent[] = [];
  for (const p of input.roster) {
    agents.push(await ensurePersona(deps, input.workspaceId, input.createdByMemberId, p));
  }
  return { agents, createdCount: agents.filter((a) => a.created).length };
}
