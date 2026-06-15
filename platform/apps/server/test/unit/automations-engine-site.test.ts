import { describe, it, expect, vi } from "vitest";
import { AutomationEngine, type AutomationEngineDeps } from "../../src/automations/engine.js";
import type { AutomationRecord } from "../../src/automations/types.js";

/**
 * #250: the engine must substitute the workspace's real site URL into the `{{site}}` template var so a
 * seeded SEO audit points the fleet at a real domain (not the "our website" placeholder), while an
 * owner-supplied `params.site` still wins.
 */

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} } as unknown as AutomationEngineDeps["logger"];

function automation(over: Partial<AutomationRecord> = {}): AutomationRecord {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: "auto_1",
    workspaceId: "w1",
    name: "SEO audit",
    triggerKind: "schedule",
    schedule: { kind: "interval", everyMinutes: 1440 } as AutomationRecord["schedule"],
    templateKey: "seo_audit",
    params: {},
    channelId: "ch_seo",
    agentHandle: "scout",
    enabled: true,
    createdByMemberId: "mem_human",
    lastRunAt: null,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function makeEngine(over: Partial<AutomationEngineDeps> = {}): { engine: AutomationEngine; launch: ReturnType<typeof vi.fn> } {
  const launch = vi.fn(async () => ({ id: "sess_1" }));
  const deps: AutomationEngineDeps = {
    store: {
      recordRun: async (i) => ({ id: "run_1", ...i }) as never,
      countRunsInWindow: async () => 0,
    } as unknown as AutomationEngineDeps["store"],
    launcher: { launch },
    resolveAgentMember: async () => ({ agentMemberId: "mem_scout" }),
    caps: () => ({ enabled: true, maxRunsPerWindow: 100, windowMinutes: 60, maxPerWorkspace: 100 }),
    killSwitch: async () => false,
    logger: noopLogger,
    ...over,
  };
  return { engine: new AutomationEngine(deps), launch };
}

describe("AutomationEngine {{site}} substitution (#250)", () => {
  it("injects the resolved site URL into the launched task", async () => {
    const { engine, launch } = makeEngine({ resolveSiteUrl: () => "https://ipop.ai" });
    await engine.runAutomation(automation(), "manual");
    expect(launch).toHaveBeenCalledTimes(1);
    const task = launch.mock.calls[0]![0].task as string;
    expect(task).toContain("https://ipop.ai");
    expect(task).not.toContain("{{site}}");
    expect(task).not.toContain("our website");
  });

  it("an owner-supplied params.site wins over the resolved default", async () => {
    const { engine, launch } = makeEngine({ resolveSiteUrl: () => "https://ipop.ai" });
    await engine.runAutomation(automation({ params: { site: "https://acme.com" } }), "manual");
    const task = launch.mock.calls[0]![0].task as string;
    expect(task).toContain("https://acme.com");
    expect(task).not.toContain("https://ipop.ai");
  });

  it("keeps today's placeholder when no site resolver is wired (back-compat)", async () => {
    const { engine, launch } = makeEngine(); // no resolveSiteUrl
    await engine.runAutomation(automation(), "manual");
    const task = launch.mock.calls[0]![0].task as string;
    expect(task).toContain("our website");
  });
});
