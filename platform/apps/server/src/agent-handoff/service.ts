/**
 * The #584 handoff service — propose, accept (validation-gated), and the lifecycle around them.
 *
 * The contract this service enforces, end to end:
 *   - A handoff is created ONLY from a proposal that validates against the schema ({@link validateProposal}).
 *     An invalid proposal is never persisted; the caller gets a {@link HandoffValidationError} listing why.
 *   - An agent can **accept** a handoff ONLY when (a) the persisted record still validates against the full
 *     schema ({@link validateContract}), (b) the accepting agent is the named `toAgent`, and (c) the handoff
 *     is still `proposed`. This is the heart of #584: "an agent can only accept a handoff that validates."
 *   - There is no API that takes free text as the payload. {@link HandoffService.refuseUnstructured} exists
 *     precisely to make that explicit — handing an agent a raw message is always refused, because free text
 *     is metadata, never the thing acted upon.
 *
 * Injectable (store + clock + id generator) so tests pin ids/timestamps deterministically, mirroring the
 * project's service style (`external-audit`, `audit`). No config flag and no app wiring here — a caller
 * obtains the singleton from `default.ts`. Wiring concrete call-sites onto it is a deliberate follow-up so
 * this change stays a self-contained module (no migration, no registry edit, no merge surface).
 */

import { randomUUID } from "node:crypto";

import { InMemoryHandoffStore, type HandoffListQuery, type HandoffStore } from "./store.js";
import {
  TERMINAL_STATUSES,
  type HandoffContract,
  type HandoffEvent,
  type HandoffStatus,
} from "./types.js";
import { validateContract, validateProposal } from "./validate.js";

/** Returns the current time; injectable so tests can pin timestamps deterministically. */
export type Clock = () => Date;
/** Returns a fresh unique id; injectable so tests can pin ids deterministically. */
export type IdGenerator = () => string;

export interface HandoffServiceDeps {
  /** Shared persistence. Defaults to an in-memory store. */
  store?: HandoffStore;
  /** Time source. Defaults to wall-clock. */
  clock?: Clock;
  /** Id source. Defaults to a random UUID. */
  idGenerator?: IdGenerator;
}

/** Thrown when a proposal (or a record being accepted) fails schema validation. Carries every reason. */
export class HandoffValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`handoff failed validation: ${errors.join("; ")}`);
    this.name = "HandoffValidationError";
  }
}

/** Thrown when a handoff id does not resolve to a record. */
export class HandoffNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`handoff not found: ${id}`);
    this.name = "HandoffNotFoundError";
  }
}

/** Thrown when a transition is not permitted (wrong agent, wrong current status, terminal record). */
export class HandoffStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffStateError";
  }
}

/**
 * Thrown by {@link HandoffService.refuseUnstructured}. Its existence is the acceptance criterion "no agent
 * can act on an unstructured message" made executable: there is no path that turns free text into work.
 */
export class UnstructuredHandoffError extends Error {
  constructor() {
    super(
      "an agent cannot act on a free-text message; a handoff must be a typed contract validated against the schema",
    );
    this.name = "UnstructuredHandoffError";
  }
}

export class HandoffService {
  private readonly store: HandoffStore;
  private readonly clock: Clock;
  private readonly newId: IdGenerator;
  /** Serializes mutations per handoff id so two transitions can't race off the same stale record. */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(deps: HandoffServiceDeps = {}) {
    this.store = deps.store ?? new InMemoryHandoffStore();
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.idGenerator ?? (() => randomUUID());
  }

  /**
   * Create a handoff from an (untrusted) proposal. Validates first: an invalid proposal throws
   * {@link HandoffValidationError} and persists nothing. A valid one is sealed at `proposed` with an
   * initial history event and written to the shared store.
   */
  async propose(input: unknown): Promise<HandoffContract> {
    const result = validateProposal(input);
    if (!result.ok) {
      throw new HandoffValidationError(result.errors);
    }
    const now = this.clock().toISOString();
    const proposal = result.value;
    const contract: HandoffContract = {
      id: this.newId(),
      workspaceId: proposal.workspaceId,
      fromAgent: proposal.fromAgent,
      toAgent: proposal.toAgent,
      artifactRef: proposal.artifactRef,
      intent: proposal.intent,
      acceptanceCriteria: proposal.acceptanceCriteria,
      status: "proposed",
      note: proposal.note,
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: "proposed", actor: proposal.fromAgent, reason: null }],
    };
    await this.store.put(contract);
    return contract;
  }

  /**
   * Accept a handoff — the validation gate. The accepting agent must be the named `toAgent`, the record
   * must still validate against the full schema, and it must still be `proposed`. Only then does it flip to
   * `accepted`. A record that does not validate can never be accepted, so no agent acts on a malformed
   * handoff.
   */
  accept(id: string, byAgent: string): Promise<HandoffContract> {
    return this.transition(id, byAgent, (contract) => {
      const validated = validateContract(contract);
      if (!validated.ok) {
        throw new HandoffValidationError(validated.errors);
      }
      if (contract.status !== "proposed") {
        throw new HandoffStateError(`cannot accept a handoff in status "${contract.status}"`);
      }
      if (byAgent !== contract.toAgent) {
        throw new HandoffStateError(`only the named recipient "${contract.toAgent}" may accept this handoff`);
      }
      return "accepted";
    });
  }

  /** Reject a still-open handoff. Only the recipient may reject, and only while it is `proposed`. */
  reject(id: string, byAgent: string, reason?: string): Promise<HandoffContract> {
    return this.transition(
      id,
      byAgent,
      (contract) => {
        if (contract.status !== "proposed") {
          throw new HandoffStateError(`cannot reject a handoff in status "${contract.status}"`);
        }
        if (byAgent !== contract.toAgent) {
          throw new HandoffStateError(`only the named recipient "${contract.toAgent}" may reject this handoff`);
        }
        return "rejected";
      },
      reason,
    );
  }

  /** Mark an accepted handoff complete. Only the recipient (who accepted it) may complete it. */
  complete(id: string, byAgent: string): Promise<HandoffContract> {
    return this.transition(id, byAgent, (contract) => {
      if (contract.status !== "accepted") {
        throw new HandoffStateError(`cannot complete a handoff in status "${contract.status}"`);
      }
      if (byAgent !== contract.toAgent) {
        throw new HandoffStateError(`only the recipient "${contract.toAgent}" may complete this handoff`);
      }
      return "completed";
    });
  }

  /** Cancel a still-open handoff. Only the proposer may cancel, and only while it is `proposed`. */
  cancel(id: string, byAgent: string, reason?: string): Promise<HandoffContract> {
    return this.transition(
      id,
      byAgent,
      (contract) => {
        if (contract.status !== "proposed") {
          throw new HandoffStateError(`cannot cancel a handoff in status "${contract.status}"`);
        }
        if (byAgent !== contract.fromAgent) {
          throw new HandoffStateError(`only the proposer "${contract.fromAgent}" may cancel this handoff`);
        }
        return "cancelled";
      },
      reason,
    );
  }

  /**
   * Refuse to act on an unstructured free-text message. There is intentionally no way to coerce raw text
   * into a handoff: this method always throws {@link UnstructuredHandoffError}. It exists so the rule "no
   * agent can act on an unstructured message" is enforced in code, not just by omission.
   */
  refuseUnstructured(_message: string): never {
    throw new UnstructuredHandoffError();
  }

  /** Look up one handoff by id (null if absent). */
  get(id: string): Promise<HandoffContract | null> {
    return this.store.get(id);
  }

  /** Read the handoff log (every cross-agent handoff), filtered by the query, in creation order. */
  list(query?: HandoffListQuery): Promise<HandoffContract[]> {
    return this.store.list(query);
  }

  /**
   * Apply a guarded status transition under a per-id lock. The `decide` callback inspects the current
   * record and returns the next status or throws to refuse; on success a history event is appended and the
   * updated record is persisted. Serializing per id prevents two concurrent transitions from both reading
   * the same `proposed` record and double-applying.
   */
  private transition(
    id: string,
    actor: string,
    decide: (contract: HandoffContract) => HandoffStatus,
    reason?: string,
  ): Promise<HandoffContract> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const next = prior.then(() => this.applyTransition(id, actor, decide, reason));
    this.tails.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async applyTransition(
    id: string,
    actor: string,
    decide: (contract: HandoffContract) => HandoffStatus,
    reason?: string,
  ): Promise<HandoffContract> {
    const current = await this.store.get(id);
    if (!current) {
      throw new HandoffNotFoundError(id);
    }
    if (TERMINAL_STATUSES.includes(current.status)) {
      throw new HandoffStateError(`handoff "${id}" is in terminal status "${current.status}" and cannot change`);
    }
    const nextStatus = decide(current);
    const at = this.clock().toISOString();
    const event: HandoffEvent = {
      at,
      status: nextStatus,
      actor,
      reason: reason !== undefined ? sanitizedReason(reason) : null,
    };
    const updated: HandoffContract = {
      ...current,
      status: nextStatus,
      updatedAt: at,
      history: [...current.history, event],
    };
    await this.store.put(updated);
    return updated;
  }
}

/** Reasons are free-text metadata: strip control chars, collapse whitespace, cap length, or null. */
function sanitizedReason(reason: string): string | null {
  let out = "";
  for (const ch of reason) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return null;
  return out.length > 500 ? out.slice(0, 500).trim() : out;
}
