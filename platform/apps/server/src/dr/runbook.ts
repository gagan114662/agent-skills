/**
 * Disaster-recovery runbook logic (#99, ADR-0099).
 *
 * The pure decision points — `preflight` (abort with no outage) and `guardDisaster` (DISASTER needs
 * explicit #13 approval, never agent-initiated) — are unit-tested with no IO. `runValidationDrill`
 * orchestrates the non-destructive drill: download the latest dump, restore into a throwaway DB,
 * verify, report. The DISASTER ordering (maintenance ON → snapshot-first → restore → verify → only
 * then maintenance OFF; verification failure leaves maintenance ON and stops) is documented in
 * `docs/playbooks/restore-runbook.md` and enforced by `guardDisaster` + the #13 gate.
 */
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { DR_RESTORE_ACTION } from "../approvals/policy.js";
import { restoreDatabase } from "./dump.js";
import { snapshotExpectations, verifyRestore, type VerifyReport } from "./verify.js";
import type { ObjectStore } from "./object-store.js";

export type RestoreMode = "validation" | "disaster";

export interface PreflightInput {
  /** Are the object-store credentials present (read for a restore, write for a backup)? */
  credsPresent: boolean;
  /** Was a candidate dump found? */
  dumpPresent: boolean;
  /** Size of that dump in bytes (0 = empty/corrupt). */
  dumpBytes: number;
  /** Age of the dump in ms, or null if unknown (freshness only enforced when known). */
  dumpAgeMs: number | null;
  /** Maximum tolerated dump age in ms. */
  maxDumpAgeMs: number;
}

export interface PreflightResult {
  proceed: boolean;
  abort?: string;
}

/**
 * The pre-flight creds/dump check. Runs **before** any maintenance flip so a doomed restore aborts
 * with **no outage**. Pure. ADR-0099 §7.
 */
export function preflight(input: PreflightInput): PreflightResult {
  if (!input.credsPresent) return { proceed: false, abort: "missing object-store credentials" };
  if (!input.dumpPresent || input.dumpBytes <= 0) {
    return { proceed: false, abort: "missing or empty dump" };
  }
  if (input.dumpAgeMs !== null && input.dumpAgeMs > input.maxDumpAgeMs) {
    return { proceed: false, abort: "latest dump is too stale" };
  }
  return { proceed: true };
}

/** Thrown when a DISASTER restore is attempted without an approved `dr.restore` #13 gate. */
export class DisasterNotApproved extends Error {
  constructor(message = "DISASTER restore requires an approved dr.restore human approval (#13)") {
    super(message);
    this.name = "DisasterNotApproved";
  }
}

/** The minimal shape of a #13 approval the disaster gate inspects. */
export interface DrApproval {
  action: string;
  status: string;
}

/**
 * Enforce that a DISASTER (destructive) restore is human-approved and never agent-initiated. Pure.
 * VALIDATION is non-destructive and needs nothing. DISASTER throws unless handed an **approved**
 * `dr.restore` approval. ADR-0099 §6.
 */
export function guardDisaster(mode: RestoreMode, approval?: DrApproval | null): void {
  if (mode === "validation") return;
  if (!approval || approval.action !== DR_RESTORE_ACTION || approval.status !== "approved") {
    throw new DisasterNotApproved();
  }
}

export interface ValidationDrillInput {
  /** Where dumps live (a fake LocalDir bucket in tests; the real S3-compatible store in prod). */
  store: ObjectStore;
  /** Object-key prefix the dumps are stored under. */
  prefix: string;
  /** The live DB the restore is verified against (counts + checksums snapshotted from it). */
  sourceUrl: string;
  /** A pre-created empty database to restore into (the caller drops it afterward). */
  throwawayUrl: string;
  /** Tables to count + content-checksum. */
  anchorTables: string[];
  /** Optional freshness probe (newest `column` of `table` within `maxAgeMs` of `now`). */
  freshness?: { table: string; column: string; maxAgeMs: number; now: Date };
}

/**
 * Run the non-destructive VALIDATION drill: pull the latest dump from the store, restore it into the
 * throwaway DB, and verify counts + schema + freshness + checksums against the live source. Returns
 * the verify report. Never touches the source destructively (read-only) and never flips maintenance.
 */
export async function runValidationDrill(input: ValidationDrillInput): Promise<VerifyReport> {
  const latest = await input.store.getLatest(input.prefix);
  if (!latest) {
    throw new Error(`no dump found under prefix "${input.prefix}" — cannot run the validation drill`);
  }
  if (latest.bytes <= 0) {
    throw new Error(`latest dump "${latest.key}" is empty — refusing to restore a zero-byte dump`);
  }

  const workDir = await mkdtemp(join(tmpdir(), "dr-drill-"));
  const localDump = join(workDir, "latest.sql.gz");
  try {
    await input.store.download(latest.key, localDump);
    await restoreDatabase(input.throwawayUrl, localDump);

    const source = new pg.Client({ connectionString: input.sourceUrl });
    const target = new pg.Client({ connectionString: input.throwawayUrl });
    await source.connect();
    await target.connect();
    try {
      const expectations = await snapshotExpectations(source, input.anchorTables, input.freshness);
      return await verifyRestore(target, expectations);
    } finally {
      await source.end().catch(() => undefined);
      await target.end().catch(() => undefined);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
