/**
 * The #672 external-action audit log — the recording API.
 *
 * Every outbound side effect (publish, send, post, spend, third-party API call) calls
 * {@link ExternalActionAuditLog.record} at the moment it happens. The service reads the current chain
 * head from the append-only store, seals the input into a hash-linked {@link AuditRecord} (stamping the
 * timestamp from an injected clock), and appends it. It never updates or deletes — the store has no
 * such method — so the history is immutable by construction and tamper-evident by hash chain.
 *
 * Pure-ish and fully injectable (store + clock), mirroring the project's service style (`analytics`,
 * `audit`). No config flag and no app wiring here: a caller obtains the singleton from `default.ts` and
 * records. Wiring concrete outbound call-sites into it is a deliberate follow-up so this change stays a
 * self-contained module (no migrations, no registry edits, no merge surface).
 */

import { sealRecord, verifyChain } from "./chain.js";
import { toAuditExport, toNdjson, type AuditExport } from "./export.js";
import { InMemoryAuditLogStore, type AuditListQuery, type AuditLogStore } from "./store.js";
import type { AuditRecord, ExternalActionInput, VerifyResult } from "./types.js";

/** Returns the current time; injectable so tests can pin timestamps deterministically. */
export type Clock = () => Date;

export interface AuditLogDeps {
  /** Append-only persistence. Defaults to an in-memory store. */
  store?: AuditLogStore;
  /** Time source. Defaults to wall-clock. */
  clock?: Clock;
}

export class ExternalActionAuditLog {
  private readonly store: AuditLogStore;
  private readonly clock: Clock;
  /** Serializes appends per workspace so concurrent records can't both seal off the same stale head. */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(deps: AuditLogDeps = {}) {
    this.store = deps.store ?? new InMemoryAuditLogStore();
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Record one external action, returning the sealed (immutable) record. Appends are serialized per
   * workspace: a record always links to the true current head, so two near-simultaneous records can't
   * fork the chain off the same predecessor.
   */
  async record(input: ExternalActionInput): Promise<AuditRecord> {
    const prior = this.tails.get(input.workspaceId) ?? Promise.resolve();
    const next = prior.then(() => this.appendOne(input));
    // Keep the chain alive even if one append rejects, but don't surface the prior error to this caller.
    this.tails.set(
      input.workspaceId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private async appendOne(input: ExternalActionInput): Promise<AuditRecord> {
    const head = await this.store.head(input.workspaceId);
    const record = sealRecord(head, input, this.clock().toISOString());
    await this.store.append(record);
    return record;
  }

  /** Read the log back in chain order (oldest first). */
  async list(query?: AuditListQuery): Promise<AuditRecord[]> {
    return this.store.list(query);
  }

  /** Verify the integrity of a workspace's chain (or the whole store when `workspaceId` is omitted). */
  async verify(workspaceId?: string): Promise<VerifyResult> {
    return verifyChain(await this.store.list(workspaceId ? { workspaceId } : undefined));
  }

  /** Export a workspace's log (or all) as newline-delimited JSON. */
  async exportNdjson(workspaceId?: string): Promise<string> {
    return toNdjson(await this.store.list(workspaceId ? { workspaceId } : undefined));
  }

  /** Export a workspace's log (or all) as a self-verifying JSON bundle. */
  async exportBundle(workspaceId?: string): Promise<AuditExport> {
    return toAuditExport(await this.store.list(workspaceId ? { workspaceId } : undefined), workspaceId ?? null);
  }
}
