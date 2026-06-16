/**
 * The A2A (agent-to-agent) call decision (#282, ADR-0282) — **pure** and dependency-free, the heart of
 * the registry's "agents can call each other" capability and the single place the call is governed. It
 * decides whether agent A may hand a task to agent B, and returns an observable {@link A2ACallRecord} for
 * the hop either way (allowed or denied), so a refused call is never invisible.
 *
 * Premortem #200 is honored here, structurally:
 *   - **Injection defense (FM#6).** The call's `task` is treated as untrusted DATA: it is sanitized
 *     (control chars stripped, whitespace collapsed, length-capped) and becomes the target's task string
 *     — it can NEVER widen the target's tool/skill scope, name a tool, or change the capability. The
 *     caller/target/capability are STRUCTURAL and validated against the registry; nothing in the body can
 *     promote a call to one the registry didn't already allow. This mirrors the #223 quarantine pattern.
 *   - **Bounded autonomy (FM#5/§5).** A hard depth cap and a cycle guard prevent an A2A loop from
 *     fanning out without owner attention — A can call B, B can call C, but the chain is bounded and a
 *     handle already on the chain can't be called again.
 *   - **Irreversible/risky stays human-gated (FM#4).** The handoff itself only launches a *draft* session
 *     (reversible), so it is autonomous (#243); the target's downstream gated actions (a real send/spend)
 *     are surfaced on the record but remain the #13 owner gate — the A2A path grants no new authority.
 */
import type { AgentRegistry } from "./registry.js";
import type { A2ACallDecision, A2ACallRecord } from "./types.js";

/** Mention-safe + shell-safe handle charset — the same gate the subagent scope uses (`scope.ts`). */
const HANDLE_RE = /^[A-Za-z0-9._-]+$/;

/** A capability name must be a dotted, lowercase-ish token — structural, never free text. */
const CAPABILITY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** Hard ceiling on the task DATA handed to the target (defense-in-depth; the body is never instructions). */
export const MAX_TASK_LENGTH = 2000;

/** Default hard cap on A2A call depth (bounded autonomy, #200 §5). Overridable via caps. */
export const DEFAULT_MAX_CALL_DEPTH = 3;

/**
 * Sanitize the A2A task body into safe DATA: strip control characters (incl. NUL), collapse runs of
 * whitespace, trim, and cap the length. This is the SAME defense-in-depth as `quarantine.sanitizeExcerpt`
 * — the real protection is architectural (the body never reaches a tool/scope), this just keeps the data
 * clean. Pure + total.
 */
export function sanitizeTask(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0/C1 control chars (keep ordinary printable + space, which the collapse below normalizes).
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_TASK_LENGTH ? out.slice(0, MAX_TASK_LENGTH).trim() : out;
}

export interface A2ACallInput {
  /** The initiating agent (a fleet @handle). */
  callerHandle: string;
  /** The agent being called (a fleet @handle). */
  targetHandle: string;
  /** The capability requested on the target (must be one the target advertises). */
  capability: string;
  /** The free-text brief for the target — treated as untrusted DATA (sanitized, never instructions). */
  task: string;
  /**
   * The chain of handles already on this call path, oldest first (e.g. `["scout"]` when scout calls
   * quill). The new hop's depth is `callChain.length`; a target already on the chain is a cycle.
   */
  callChain?: readonly string[];
  /** Override the depth cap (from caps); defaults to {@link DEFAULT_MAX_CALL_DEPTH}. */
  maxDepth?: number;
}

/** A deterministic, timestamp-free id for a hop, so the record is reproducible in a unit test. */
function deriveCallId(chain: readonly string[], target: string, capability: string): string {
  return [...chain, `${target}#${capability}`].join(">");
}

function deny(
  input: A2ACallInput,
  depth: number,
  reason: string,
  riskTier: A2ACallRecord["riskTier"] = "read_only",
  downstreamGatedActions: string[] = [],
): A2ACallDecision {
  return {
    allowed: false,
    record: {
      callId: deriveCallId(input.callChain ?? [], input.targetHandle, input.capability),
      callerHandle: input.callerHandle,
      targetHandle: input.targetHandle,
      capability: input.capability,
      riskTier,
      task: sanitizeTask(input.task ?? ""),
      depth,
      downstreamGatedActions,
      status: "denied",
      reason,
    },
  };
}

/**
 * Decide whether an A2A call may proceed, given the workspace `registry`. Returns the observable hop
 * record either way. Total — never throws; an invalid call is a `denied` record with a reason. The order
 * of checks is deliberate (structural identity → registry membership → capability → content → bounds) so
 * the densest failure (a poisoned/unknown caller) is caught first.
 */
export function decideA2ACall(input: A2ACallInput, registry: AgentRegistry): A2ACallDecision {
  const chain = input.callChain ?? [];
  const depth = chain.length;
  const maxDepth = input.maxDepth ?? DEFAULT_MAX_CALL_DEPTH;

  // 1. Structural identity: caller/target/capability must be well-formed tokens (injection defense — a
  //    handle or capability is never free text). Validate BEFORE touching the registry.
  if (!HANDLE_RE.test(input.callerHandle)) {
    return deny(input, depth, "caller handle is not a valid agent handle");
  }
  if (!HANDLE_RE.test(input.targetHandle)) {
    return deny(input, depth, "target handle is not a valid agent handle");
  }
  if (!CAPABILITY_RE.test(input.capability)) {
    return deny(input, depth, "capability is not a valid capability token");
  }
  if (input.callerHandle === input.targetHandle) {
    return deny(input, depth, "an agent cannot call itself");
  }

  // 2. Registry membership: the caller must be a known fleet agent, and the target must be ENABLED for
  //    A2A in this workspace (present + flag on + owner-first satisfied). A disabled/absent target is a
  //    deny — the body can never reach an agent the registry didn't already expose.
  const caller = registry.findEntry(input.callerHandle);
  if (!caller) {
    return deny(input, depth, "caller is not a registered fleet agent");
  }
  const target = registry.findEntry(input.targetHandle);
  if (!target) {
    return deny(input, depth, "target is not a registered fleet agent");
  }
  if (!target.enabled) {
    return deny(
      input,
      depth,
      target.present
        ? "target agent is not enabled for A2A in this workspace"
        : "target agent has not been hired in this workspace",
      target.contract.riskTier,
      target.contract.gatedActions,
    );
  }

  const riskTier = target.contract.riskTier;
  const gated = target.contract.gatedActions;

  // 3. Capability: the target must actually advertise the requested capability. A call for a capability
  //    the contract doesn't declare is rejected (no implicit/forged capabilities).
  if (!target.contract.capabilities.includes(input.capability)) {
    return deny(input, depth, `target does not advertise capability "${input.capability}"`, riskTier, gated);
  }

  // 4. Content: the task is untrusted DATA; sanitize and require it to be non-empty after cleaning.
  const task = sanitizeTask(input.task ?? "");
  if (task.length === 0) {
    return deny(input, depth, "an A2A call needs a non-empty task", riskTier, gated);
  }

  // 5. Bounds (premortem §5): depth cap + cycle guard so the fleet can't fan out without owner attention.
  if (depth >= maxDepth) {
    return deny(input, depth, `A2A call depth ${depth} exceeds the cap of ${maxDepth}`, riskTier, gated);
  }
  if (chain.includes(input.targetHandle)) {
    return deny(input, depth, `cycle: ${input.targetHandle} is already on the call chain`, riskTier, gated);
  }

  return {
    allowed: true,
    record: {
      callId: deriveCallId(chain, input.targetHandle, input.capability),
      callerHandle: input.callerHandle,
      targetHandle: input.targetHandle,
      capability: input.capability,
      riskTier,
      task,
      depth,
      downstreamGatedActions: [...gated],
      status: "allowed",
      reason:
        gated.length > 0
          ? `allowed — output may trigger ${gated.join(", ")}, which stays owner-gated (#13)`
          : "allowed",
    },
  };
}

/** Append a successful hop's target to the call chain, for the next hop's depth/cycle accounting. Pure. */
export function appendHop(chain: readonly string[], targetHandle: string): string[] {
  return [...chain, targetHandle];
}
