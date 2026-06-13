/**
 * Receipts (#174, ADR-0174) — the "why?" surface for the agent browser. EVERY browser step (allowed,
 * denied, or awaiting approval) logs a receipt: the URL, the action, the decision, the #13 approval id
 * (when gated), and a screenshot path (when the step rendered something). Screenshots become deliverable
 * attachments and feed the console's live screenshot stream. The recorder is a seam: the unit job uses
 * the in-memory recorder; production writes `browser_steps` rows (migration 0174) via the repository.
 */
import type { BrowserDecisionKind } from "./decide.js";
import type { BrowserToolName } from "./tools.js";

export interface BrowserReceipt {
  sessionId: string;
  workspaceId: string;
  /** 1-based step counter within the session — the order the agent drove the browser. */
  stepNo: number;
  tool: BrowserToolName;
  /** The URL the action touched (navigation target or current page), or null when none. */
  url: string | null;
  sideEffectful: boolean;
  decision: BrowserDecisionKind;
  /** The #13 approval request id, when the step was gated; null otherwise. */
  approvalRequestId: string | null;
  /** A stored screenshot path (a deliverable attachment), or null when the step rendered nothing. */
  screenshotPath: string | null;
  /** Bytes transferred by this step (for the bandwidth audit). */
  bytes: number;
  /** A short human-readable note (the decision reason / selector / summary). */
  detail: string;
}

export interface BrowserReceiptRecorder {
  record(receipt: BrowserReceipt): Promise<void>;
}

export interface InMemoryReceiptRecorder extends BrowserReceiptRecorder {
  readonly receipts: BrowserReceipt[];
}

/** An in-memory recorder for the unit job (and a sane default when no DB recorder is wired). */
export function inMemoryReceiptRecorder(): InMemoryReceiptRecorder {
  const receipts: BrowserReceipt[] = [];
  return {
    receipts,
    async record(receipt): Promise<void> {
      receipts.push(receipt);
    },
  };
}
