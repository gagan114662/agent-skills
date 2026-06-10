import { describe, it, expect, beforeEach } from "vitest";
import {
  recordWarmHit,
  recordWarmMiss,
  recordAdmissionDenied,
  recordRegionPlacement,
  renderMetrics,
  resetMetrics,
} from "../../src/observability/metrics.js";

describe("scale metrics (#71 — dependency-free registry, no tenant labels)", () => {
  beforeEach(() => resetMetrics());

  it("renders warm-pool hit/miss counters", () => {
    recordWarmHit();
    recordWarmHit();
    recordWarmMiss();
    const out = renderMetrics();
    expect(out).toContain("# TYPE scale_warm_hits_total counter");
    expect(out).toMatch(/scale_warm_hits_total 2/);
    expect(out).toMatch(/scale_warm_misses_total 1/);
  });

  it("renders admission denials labelled by reason (a bounded label set)", () => {
    recordAdmissionDenied("budget_exceeded");
    recordAdmissionDenied("tenant_capacity");
    recordAdmissionDenied("budget_exceeded");
    const out = renderMetrics();
    expect(out).toContain('scale_admission_denied_total{reason="budget_exceeded"} 2');
    expect(out).toContain('scale_admission_denied_total{reason="tenant_capacity"} 1');
  });

  it("renders region placements labelled by region", () => {
    recordRegionPlacement("iad1");
    recordRegionPlacement("iad1");
    recordRegionPlacement("sfo1");
    const out = renderMetrics();
    expect(out).toContain('scale_region_sessions_total{region="iad1"} 2');
    expect(out).toContain('scale_region_sessions_total{region="sfo1"} 1');
  });

  it("resetMetrics clears the scale series (test isolation)", () => {
    recordWarmHit();
    recordAdmissionDenied("kill_switch");
    recordRegionPlacement("iad1");
    resetMetrics();
    const out = renderMetrics();
    expect(out).toMatch(/scale_warm_hits_total 0/);
    expect(out).not.toContain("scale_admission_denied_total{");
    expect(out).not.toContain("scale_region_sessions_total{");
  });
});
