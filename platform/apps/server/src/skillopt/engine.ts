import type { SessionLogger } from "../runtime/manager.js";
import type { SkillOptIdentity, SkillOptRunResult } from "./service.js";

/**
 * SkillOpt-Sleep scheduled tick (#283, ADR-0283) — the nightly/idle "sleep" trigger that runs each owner
 * workspace's offline self-improvement cycle on infrastructure time. Modelled EXACTLY on the #416
 * `CadenceEngine`: an opt-in periodic timer (default OFF; started in `index.ts` only when
 * `RELOAD_SKILLOPT_INTERVAL_MS > 0`) that does ONE conservative thing per workspace per tick — one
 * `SkillOptService.runWorkspace` pass (harvest → mine → gate → stage at most one bounded proposal in the #13
 * queue, and durably record the run + its before/after signal).
 *
 * Conservatism is structural and answers the premortem (#200):
 *   - **The cycle owns no authority.** A pass stages at most a PENDING #13 request the owner adopts (or not);
 *     it NEVER edits a skill doc, touches money, or takes an external action — so the timer adds none either.
 *   - **Per-workspace gate re-check.** `runWorkspace` self-gates on the layered config (default OFF,
 *     owner-workspace-first), so a started timer ticks nobody until a deployment opts a workspace in.
 *   - **A failing pass never crashes the timer.** Every per-workspace error is caught and logged, so one
 *     workspace's failure can't stop the others or throw out of the interval.
 *
 * All side effects are injected (the workspace work-list, the owner-member resolver, the service), so the
 * engine itself is pure scheduling + bookkeeping and runs against fakes in unit tests.
 */
export interface SkillOptEngineDeps {
  /**
   * The workspaces to tick — the owner work-list. Derived from `caps.ownerWorkspaceId` in the default
   * wiring; a workspace the config has not enabled is skipped by `runWorkspace`'s own gate even if listed.
   */
  ownerWorkspaces: () => string[];
  /**
   * Resolve the member a staged proposal is attributed to (the accountable owner). Null ⇒ the workspace has
   * no owner member yet, so the pass is skipped (nothing to request a #13 adoption as).
   */
  ownerMemberId: (workspaceId: string) => Promise<string | null>;
  /** Run one workspace's offline cycle (the production `SkillOptService.runWorkspace`). */
  run: (identity: SkillOptIdentity) => Promise<SkillOptRunResult>;
  logger: SessionLogger;
}

export class SkillOptEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: SkillOptEngineDeps) {}

  /** Start the periodic loop. No-op if interval ≤ 0 or already started (mirrors CadenceEngine). */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One conservative pass: for each owner workspace, run its offline cycle once. Never throws — every
   * per-workspace error is caught and logged so a failure or a bug can't crash the timer. Returns the per-
   * workspace run results (useful for tests / a manual trigger); a skipped workspace yields no result.
   */
  async tickAll(): Promise<SkillOptRunResult[]> {
    const results: SkillOptRunResult[] = [];
    for (const workspaceId of this.deps.ownerWorkspaces()) {
      try {
        const requesterMemberId = await this.deps.ownerMemberId(workspaceId);
        if (!requesterMemberId) continue; // no accountable owner ⇒ nothing to stage a proposal as.
        results.push(await this.deps.run({ workspaceId, requesterMemberId }));
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "skillopt tickAll: workspace cycle failed (skipped)");
      }
    }
    return results;
  }
}
