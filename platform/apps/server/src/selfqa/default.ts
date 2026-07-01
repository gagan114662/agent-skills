import { loadConfig } from "../config/loader.js";
import { resolveSelfqaCaps } from "./caps.js";
import { resolveDriver } from "./driver.js";
import { SelfQaRunner } from "./runner.js";
import { SelfQaEngine } from "./engine.js";
import { flywheelReporter } from "./bridge.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { getControls } from "../db/repositories/autonomy.js";
import { getWorkspaceBySlug } from "../db/repositories/workspaces.js";
import { startSelfqaRun, finishSelfqaRun } from "../db/repositories/selfqa.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import type { SessionLogger } from "../runtime/manager.js";
import type { FailureEvent } from "../flywheel/types.js";
import type { QaFinding } from "./types.js";
import { DEFAULT_PUBLIC_APP_ORIGIN } from "../product-origins.js";

/**
 * Production wiring for the Self-QA Loop (#171, ADR-0171). Default-OFF (config `selfqa.enabled` +
 * `SELFQA_INTERVAL_MS`), so wiring it changes nothing until an operator opts in. The driver defaults to
 * the **no-op** (`SELFQA_DRIVER=none`) so the in-process timer never touches the network unless configured;
 * the always-on entry point is the CI CLI (`selfqa:run`), not this timer.
 *
 * `flywheelRecord` is the #117 ingestion seam (an enabled engine records every finding as a `qa_failure`
 * so it flows through the deduped ledger). The engine is tenant-locked to the reserved synthetic workspace.
 */

/** Best-effort owner page for a critical self-QA finding, through the SAME #148 PagerService as the SRE/uptime loops. */
async function pageOwnerForSelfqa(workspaceId: string, finding: QaFinding, logger: SessionLogger): Promise<void> {
  try {
    if (!resolveSelfqaCaps(loadConfig(workspaceId).selfqa).pageCriticalOwner) return;
    const { resolveReliabilityCaps } = await import("../reliability/caps.js");
    if (!resolveReliabilityCaps(loadConfig(workspaceId).reliability).enabled) return;
    const { createPagerService } = await import("../reliability/default.js");
    const pager = createPagerService(logger);
    await pager.page({
      workspaceId,
      source: "selfqa",
      incidentId: null,
      kind: "selfqa_critical",
      severity: "critical",
      lastPagedAt: null,
      ackedAt: null,
      subject: `[ipop] self-QA critical: ${finding.title}`,
      body: `The synthetic QA user hit a critical failure on \`${finding.surface}\` (check \`${finding.checkId}\`).`,
    });
  } catch (err) {
    logger.error({ err, checkId: finding.checkId }, "selfqa: owner-page skipped");
  }
}

/** Build the production SelfQaEngine. The background timer is started in `index.ts` (default-off). */
export function createDefaultSelfQaEngine(
  logger: SessionLogger,
  flywheelRecord: (event: FailureEvent) => Promise<unknown>,
): SelfQaEngine {
  const target = process.env.SELFQA_TARGET ?? DEFAULT_PUBLIC_APP_ORIGIN;
  const driver = resolveDriver(process.env.SELFQA_DRIVER ?? "none");
  const caps = (workspaceId: string) => resolveSelfqaCaps(loadConfig(workspaceId).selfqa);

  const runner = new SelfQaRunner({
    driver,
    caps,
    // Tenant isolation: a workspace is "synthetic" only if it IS the one named by the reserved slug.
    isSyntheticWorkspace: async (workspaceId) => {
      const ws = await getWorkspaceBySlug(caps(workspaceId).workspaceSlug);
      return ws?.id === workspaceId;
    },
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    maintenancePaused: () => isMaintenanceActive(),
    budgetExhausted: async (workspaceId, now) =>
      budgetExceeded(
        (await getUsage(workspaceId, windowKey(now))).estimatedCostCents,
        resolveScaleCaps(loadConfig(workspaceId).scale).budgetCents,
      ),
  });

  return new SelfQaEngine({
    runner,
    caps,
    target,
    resolveSyntheticWorkspaceId: async (slug) => (await getWorkspaceBySlug(slug))?.id ?? null,
    reporter: (workspaceId) => flywheelReporter({ workspaceId, record: flywheelRecord }),
    pageOwner: (workspaceId, finding) => pageOwnerForSelfqa(workspaceId, finding, logger),
    persist: {
      start: (input) => startSelfqaRun(input),
      finish: (input) => finishSelfqaRun(input),
    },
    logger,
  });
}
