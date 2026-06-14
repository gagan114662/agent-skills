import { describe, it, expect } from "vitest";
import { decideHealth, decideRemediation } from "../../src/self-healing/decide.js";
import { resolveSelfHealingCaps, type SelfHealingCaps } from "../../src/self-healing/caps.js";
import type { VentureHealth } from "../../src/self-healing/types.js";

const thresholds = { errorRate: 0.1, queueDepth: 100 };

function health(over: Partial<VentureHealth> = {}): VentureHealth {
  return { reachable: true, errorRate: 0, queueDepth: 0, stuckAgents: 0, ...over };
}

/** Build caps from the config layer so the tests pin the real default-resolution path. */
function caps(over: Partial<SelfHealingCaps> = {}): SelfHealingCaps {
  return { ...resolveSelfHealingCaps({ enabled: true, autoRemediate: true }), ...over };
}

describe("decideHealth (#193 AC1: per-venture monitoring)", () => {
  it("healthy probe ⇒ no breaches", () => {
    expect(decideHealth(health(), thresholds)).toEqual({ healthy: true, breaches: [] });
  });

  it("a probe that ran and FAILED is an uptime breach", () => {
    const v = decideHealth(health({ reachable: false }), thresholds);
    expect(v.healthy).toBe(false);
    expect(v.breaches.map((b) => b.signal)).toEqual(["uptime"]);
  });

  it("an ABSENT probe (null) is never a breach (#200 §3: act only on a real reading)", () => {
    const v = decideHealth(health({ reachable: null, errorRate: null, queueDepth: null }), thresholds);
    expect(v).toEqual({ healthy: true, breaches: [] });
  });

  it("error rate over threshold breaches; at/under threshold does not", () => {
    expect(decideHealth(health({ errorRate: 0.2 }), thresholds).breaches[0]?.signal).toBe("error_rate");
    expect(decideHealth(health({ errorRate: 0.1 }), thresholds).healthy).toBe(true);
  });

  it("queue depth over threshold breaches", () => {
    const v = decideHealth(health({ queueDepth: 250 }), thresholds);
    expect(v.breaches[0]).toEqual({ signal: "queue_depth", observed: 250, threshold: 100 });
  });

  it("stuck agents > 0 breaches stuck_agent", () => {
    expect(decideHealth(health({ stuckAgents: 2 }), thresholds).breaches[0]?.signal).toBe("stuck_agent");
  });

  it("reports every breached signal at once", () => {
    const v = decideHealth(health({ reachable: false, errorRate: 0.9, queueDepth: 999, stuckAgents: 1 }), thresholds);
    expect(v.breaches.map((b) => b.signal).sort()).toEqual(["error_rate", "queue_depth", "stuck_agent", "uptime"]);
  });
});

describe("decideRemediation (#193 AC2: bounded auto-remediation, fail-closed)", () => {
  it("kill switch ⇒ none (authoritative halt)", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: true, attempts: 0, correlatedDeployId: null, caps: caps() });
    expect(d).toMatchObject({ action: "none", reason: "kill_switch" });
  });

  it("auto-remediation disabled ⇒ escalate (monitoring runs, nothing acts)", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps({ autoRemediate: false }) });
    expect(d).toMatchObject({ action: "escalate", reason: "auto_remediation_disabled", requiresApproval: true });
  });

  it("auto attempts exhausted ⇒ escalate (retried once, now a human — AC3)", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 1, correlatedDeployId: null, caps: caps({ maxAutoAttempts: 1 }) });
    expect(d).toMatchObject({ action: "escalate", reason: "retry_exhausted" });
  });

  it("stuck_agent ⇒ escalate (the #105 watchdog owns kill+retry)", () => {
    const d = decideRemediation({ signal: "stuck_agent", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps() });
    expect(d).toMatchObject({ action: "escalate", reason: "stuck_agent_escalated" });
  });

  it("uptime down ⇒ restart (reversible, auto-runs, no approval)", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps() });
    expect(d).toEqual({ action: "restart", reversibility: "reversible", requiresApproval: false, reason: "restart" });
  });

  it("uptime down WITH a correlated deploy + rollback allowed ⇒ rollback, gated by default", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: "dep-1", caps: caps({ allowRollback: true }) });
    expect(d).toMatchObject({ action: "rollback", reversibility: "cheap", requiresApproval: true });
  });

  it("rollback runs WITHOUT approval only when the owner pre-committed it (#200 §4)", () => {
    const d = decideRemediation({ signal: "error_rate", killSwitch: false, attempts: 0, correlatedDeployId: "dep-1", caps: caps({ allowRollback: true, preCommitRollback: true }) });
    expect(d).toMatchObject({ action: "rollback", requiresApproval: false });
  });

  it("a correlated deploy WITHOUT rollback-allowed falls back to restart", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: "dep-1", caps: caps({ allowRollback: false }) });
    expect(d.action).toBe("restart");
  });

  it("queue_depth + scale allowed ⇒ scale_up (cheap), gated by default", () => {
    const d = decideRemediation({ signal: "queue_depth", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps({ allowScale: true }) });
    expect(d).toMatchObject({ action: "scale_up", reversibility: "cheap", requiresApproval: true });
  });

  it("queue_depth WITHOUT scale allowed ⇒ escalate", () => {
    const d = decideRemediation({ signal: "queue_depth", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps({ allowScale: false }) });
    expect(d).toMatchObject({ action: "escalate", reason: "scale_not_allowed" });
  });

  it("nothing allowed ⇒ escalate (fail-closed)", () => {
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: null, caps: caps({ allowRestart: false }) });
    expect(d).toMatchObject({ action: "escalate", reason: "no_action_allowed" });
  });

  it("default caps NEVER auto-remediate (every breach escalates until the owner opts in)", () => {
    const off = resolveSelfHealingCaps(undefined);
    const d = decideRemediation({ signal: "uptime", killSwitch: false, attempts: 0, correlatedDeployId: "dep-1", caps: off });
    expect(d.action).toBe("escalate");
  });
});
