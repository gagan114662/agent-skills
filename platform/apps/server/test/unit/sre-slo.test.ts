import { describe, it, expect } from "vitest";
import { evaluateSlo, observeService } from "../../src/sre/slo.js";
import type { ServiceSignal, SloTarget } from "../../src/sre/types.js";

const availTarget = (t: number): SloTarget => ({ kind: "availability", target: t });
const latTarget = (t: number): SloTarget => ({ kind: "latency_p95", target: t });
const lagTarget = (t: number): SloTarget => ({ kind: "queue_lag", target: t });

describe("evaluateSlo — availability", () => {
  it("is not breached when the success ratio is at the target (budget exactly exhausted)", () => {
    const e = evaluateSlo(availTarget(0.999), { kind: "availability", value: 0.999, sampleCount: 1000 });
    expect(e.breached).toBe(false);
    expect(e.budgetRemaining).toBeCloseTo(0, 5);
  });

  it("is not breached with full budget when there are zero errors", () => {
    const e = evaluateSlo(availTarget(0.99), { kind: "availability", value: 1, sampleCount: 1000 });
    expect(e.breached).toBe(false);
    expect(e.budgetRemaining).toBeCloseTo(1, 5);
    expect(e.severity).toBe("warning");
  });

  it("breaches and reports critical severity when the ratio falls below target (budget gone)", () => {
    const e = evaluateSlo(availTarget(0.999), { kind: "availability", value: 0.99, sampleCount: 1000 });
    expect(e.breached).toBe(true);
    expect(e.budgetRemaining).toBe(0);
    expect(e.severity).toBe("critical");
  });

  it("treats a zero-sample observation as not breached (no signal)", () => {
    const e = evaluateSlo(availTarget(0.999), { kind: "availability", value: 0, sampleCount: 0 });
    expect(e.breached).toBe(false);
    expect(e.budgetRemaining).toBe(1);
  });
});

describe("evaluateSlo — latency_p95 + queue_lag (headroom budget)", () => {
  it("latency: not breached at/under target, full budget under target", () => {
    expect(evaluateSlo(latTarget(500), { kind: "latency_p95", value: 500, sampleCount: 10 }).breached).toBe(false);
    const under = evaluateSlo(latTarget(500), { kind: "latency_p95", value: 250, sampleCount: 10 });
    expect(under.breached).toBe(false);
    expect(under.budgetRemaining).toBe(1);
  });

  it("latency: breaches over target; budget hits 0 + critical at 2x target", () => {
    const e = evaluateSlo(latTarget(500), { kind: "latency_p95", value: 1000, sampleCount: 10 });
    expect(e.breached).toBe(true);
    expect(e.budgetRemaining).toBe(0);
    expect(e.severity).toBe("critical");
  });

  it("latency: partial burn between target and 2x is a warning", () => {
    const e = evaluateSlo(latTarget(500), { kind: "latency_p95", value: 750, sampleCount: 10 });
    expect(e.breached).toBe(true);
    expect(e.budgetRemaining).toBeCloseTo(0.5, 5);
    expect(e.severity).toBe("warning");
  });

  it("queue_lag: any lag over a zero target breaches with no budget", () => {
    const e = evaluateSlo(lagTarget(0), { kind: "queue_lag", value: 5, sampleCount: 1 });
    expect(e.breached).toBe(true);
    expect(e.budgetRemaining).toBe(0);
  });
});

describe("observeService — maps a raw signal to per-kind observations", () => {
  it("derives availability from window requests/errors", () => {
    const sig: ServiceSignal = {
      service: "api",
      windowRequests: 1000,
      windowErrors: 10,
      p95LatencyMs: 420,
      queueLagSeconds: 2,
      healthy: true,
    };
    const obs = observeService(sig);
    const avail = obs.find((o) => o.kind === "availability")!;
    expect(avail.value).toBeCloseTo(0.99, 5);
    expect(avail.sampleCount).toBe(1000);
    expect(obs.find((o) => o.kind === "latency_p95")!.value).toBe(420);
    expect(obs.find((o) => o.kind === "queue_lag")!.value).toBe(2);
  });

  it("forces availability to 0 (breach) when the health probe says the dependency is down", () => {
    const sig: ServiceSignal = {
      service: "redis",
      windowRequests: 0,
      windowErrors: 0,
      p95LatencyMs: 0,
      queueLagSeconds: 0,
      healthy: false,
    };
    const avail = observeService(sig).find((o) => o.kind === "availability")!;
    expect(avail.value).toBe(0);
    expect(avail.sampleCount).toBeGreaterThanOrEqual(1);
  });

  it("reports availability 1 with zero samples when healthy and idle (no false breach)", () => {
    const sig: ServiceSignal = {
      service: "api",
      windowRequests: 0,
      windowErrors: 0,
      p95LatencyMs: 0,
      queueLagSeconds: 0,
      healthy: true,
    };
    const avail = observeService(sig).find((o) => o.kind === "availability")!;
    expect(avail.value).toBe(1);
    expect(avail.sampleCount).toBe(0);
  });
});
