/**
 * First-run experience decisions (#301 + #299), pure so every branch is unit-tested without a clock or a
 * network. Two concerns:
 *
 *   1. AUTO-RUN (#301): a fresh workspace that lands on the board with nothing running is a dead "between
 *      tasks" board — the opposite of the "always-on department" promise. Behind a flag (default ON for
 *      new workspaces) the console auto-runs ONE safe, no-spend, no-approval deliverable (Scout audits the
 *      owner's own site) so a useful card appears within the first minute with zero setup. {@link
 *      shouldAutoRunFirstRun} decides when to fire — once on a fresh-but-ready board, then a bounded silent
 *      retry only while the prior attempt is failing (transient runner/spawn issues), never on a healthy
 *      idle board and never once a deliverable or a live session already exists.
 *
 *   2. WARMING-UP (#299): the console must NEVER render raw runner / exit-code errors. While the first
 *      deliverable is being produced — or while the auto-run is retrying through transient failures —
 *      {@link firstRunPanel} returns a calm, branded "warming up" panel instead of the server's failure
 *      copy (which names exit codes and the internal "model"/"spawn" classes). The raw recent-failure exit
 *      list is never surfaced.
 */
import type { DiagnosticState } from "../../api/types.js";

/**
 * Whether the first-run auto-deliverable is enabled. Defaults ON for new workspaces (#301): the always-on
 * department should produce value without the owner lifting a finger. A single switch so it can be turned
 * off wholesale if ever needed.
 */
export const FIRST_RUN_AUTORUN_ENABLED = true;

/** How many times the auto-run may fire in one mount before giving up (the initial run + retries). */
export const FIRST_RUN_MAX_ATTEMPTS = 3;

export interface AutoRunInput {
  /** The feature flag ({@link FIRST_RUN_AUTORUN_ENABLED}); off → never fire. */
  readonly flagOn: boolean;
  /** A workspace id is loaded (we have somewhere to run). */
  readonly hasWorkspace: boolean;
  /**
   * The board is shown (NOT the no-venture empty-state pitch, which owns its own guided activation). The
   * auto-run only applies once the owner is on a real board with departments — the case #301 describes.
   */
  readonly boardShown: boolean;
  /** Live (provisioning/running) session count right now. */
  readonly liveCount: number;
  /** How many deliverables are already visible (pending + done) — value the owner can already see. */
  readonly deliverableCount: number;
  /** A seed / auto-run is already in flight — don't double-fire. */
  readonly busy: boolean;
  /** How many times the auto-run has already fired this mount. */
  readonly attempts: number;
  /** The current "why nothing is running" classification, or null when unknown. */
  readonly diagnosticState: DiagnosticState | null;
}

/**
 * Decide whether to auto-run the safe first-run deliverable now (#301). Fires at most
 * {@link FIRST_RUN_MAX_ATTEMPTS} times: once on a fresh-but-ready board, then only as a silent retry while
 * the prior attempt is actively failing (`sessions_failing` — the transient runner/spawn case). Never
 * fires when something is already live or a deliverable already exists, and never on a healthy idle board
 * (that is a genuine "between tasks" lull the owner can brief into, not a missing first aha).
 */
export function shouldAutoRunFirstRun(i: AutoRunInput): boolean {
  if (!i.flagOn || !i.hasWorkspace || i.busy) return false;
  if (i.attempts >= FIRST_RUN_MAX_ATTEMPTS) return false;
  if (!i.boardShown) return false;
  // Value is already present (or on its way) — leave it alone.
  if (i.deliverableCount > 0 || i.liveCount > 0) return false;
  // First attempt: a fresh, ready board with nothing on it → produce the first deliverable.
  if (i.attempts === 0) return true;
  // Subsequent attempts are silent retries reserved for transient runner failures, not idle boards.
  return i.diagnosticState === "sessions_failing";
}

export type FirstRunPanelKind = "warming" | "diagnostic" | "none";

export interface FirstRunPanelInput {
  /** An auto-run is in flight (producing the first deliverable). */
  readonly autoRunning: boolean;
  /** The server diagnostic state, or null when none is present. */
  readonly diagnosticState: DiagnosticState | null;
}

/**
 * Decide what the console shows above the board (#299). A `sessions_failing` state — or an in-flight
 * auto-run — degrades to the calm branded "warming up" panel, NEVER the server's exit-code/failure-class
 * copy. `no_work` / `idle` keep the server's (already calm, exit-code-free) line. `running` / `no_venture`
 * render nothing here.
 */
export function firstRunPanel(i: FirstRunPanelInput): FirstRunPanelKind {
  if (i.autoRunning || i.diagnosticState === "sessions_failing") return "warming";
  if (i.diagnosticState === "no_work" || i.diagnosticState === "idle") return "diagnostic";
  return "none";
}
