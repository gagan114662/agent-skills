import type { DecisionMakerCaps } from "./caps.js";
import { assembleBrief, candidateHooksFromReads } from "./brief.js";
import { resolveBuyer } from "./resolve.js";
import { StaticProfileReader, type QuarantinedProfileReader } from "./quarantine.js";
import type {
  AccountSource,
  BuyerBrief,
  BuyerBriefRecord,
  TargetAccount,
} from "./types.js";

/**
 * Decision-maker resolver orchestrator (#223, ADR-0223). Resolves the best buyer (pure {@link resolveBuyer}),
 * enriches them through the QUARANTINED reader, assembles the brief (pure {@link assembleBrief}), and
 * persists the brief — the ONLY thing this loop persists (#200: nothing beyond the brief).
 *
 * GUARDRAIL: the dependency surface here is the proof of the injection defense. It contains a read-only
 * {@link QuarantinedProfileReader}, a {@link BriefStore}, a config resolver, and an optional #222
 * {@link AccountSource}. There is **no** #13 gate, no external-send seam, no spend seam — by construction
 * this service cannot send, post, or charge. Whatever a poisoned profile says, it has no action to reach.
 */

/** Persist seam for the produced brief. Minimal, public, cited — no sensitive PII (#200). */
export interface BriefStore {
  insert(input: {
    workspaceId: string;
    ideaId: string | null;
    brief: BuyerBrief;
  }): Promise<BuyerBriefRecord>;
  list(workspaceId: string): Promise<BuyerBriefRecord[]>;
  get(workspaceId: string, id: string): Promise<BuyerBriefRecord | undefined>;
}

export interface DecisionMakerDeps {
  /** The QUARANTINED reader — DATA-only, no send/spend. Defaults to the no-network {@link StaticProfileReader}. */
  reader?: QuarantinedProfileReader;
  briefs: BriefStore;
  caps: (workspaceId: string) => DecisionMakerCaps;
  /** Optional #222 seam — resolve an account by id once the discovery queue has landed. */
  accounts?: AccountSource;
}

/** Raised by `resolveById` when no #222 account source is wired (or the account is unknown). */
export class AccountNotAvailableError extends Error {
  constructor(accountId: string) {
    super(`account not available (no #222 discovery source wired): ${accountId}`);
    this.name = "AccountNotAvailableError";
  }
}

export class DecisionMakerService {
  private readonly reader: QuarantinedProfileReader;
  private readonly deps: DecisionMakerDeps;

  constructor(deps: DecisionMakerDeps) {
    this.deps = deps;
    this.reader = deps.reader ?? new StaticProfileReader();
  }

  /**
   * Resolve + enrich a target account into a persisted buyer brief. Reads ONLY the resolved buyer's public
   * sources (minimal personal data — we read what the single outreach needs, not the whole org). Throws
   * {@link NoResolvableBuyerError} when the buyer pool is empty.
   */
  async resolveAccount(workspaceId: string, account: TargetAccount): Promise<BuyerBriefRecord> {
    const resolution = resolveBuyer(account);
    // Minimal-data discipline: enrich only the chosen buyer, not every contact in the pool.
    const buyerSources = account.sources.filter((s) => s.contactId === resolution.contact.id);
    const reads = await Promise.all(buyerSources.map((s) => this.reader.read(s)));
    const caps = this.deps.caps(workspaceId);
    const candidates = candidateHooksFromReads(reads);
    const brief = assembleBrief(account, resolution, reads, candidates, caps.maxHooks);
    return this.deps.briefs.insert({ workspaceId, ideaId: account.ideaId ?? null, brief });
  }

  /** Resolve by account id via the #222 seam (when wired). Throws {@link AccountNotAvailableError} otherwise. */
  async resolveById(workspaceId: string, accountId: string): Promise<BuyerBriefRecord> {
    const account = await this.deps.accounts?.getAccount(workspaceId, accountId);
    if (!account) throw new AccountNotAvailableError(accountId);
    return this.resolveAccount(workspaceId, account);
  }

  async listBriefs(workspaceId: string): Promise<BuyerBriefRecord[]> {
    return this.deps.briefs.list(workspaceId);
  }

  async getBrief(workspaceId: string, id: string): Promise<BuyerBriefRecord | undefined> {
    return this.deps.briefs.get(workspaceId, id);
  }
}
