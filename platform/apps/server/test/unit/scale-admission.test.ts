import { describe, it, expect } from "vitest";
import { Admission, AdmissionError } from "../../src/scale/admission.js";
import type { AdmissionDeps } from "../../src/scale/admission.js";
import { CONFIG_DEFAULTS, type ResolvedConfig, type ScaleConfig } from "../../src/config/schema.js";
import { EMPTY_USAGE, type UsageReader, type UsageSnapshot } from "../../src/scale/usage.js";
import type { KillSwitchReader } from "../../src/scale/admission.js";

// --- fakes ------------------------------------------------------------------

class FakeUsage implements UsageReader {
  private readonly rows = new Map<string, UsageSnapshot>();
  set(workspaceId: string, window: string, snap: Partial<UsageSnapshot>): void {
    this.rows.set(`${workspaceId}|${window}`, { ...EMPTY_USAGE, ...snap });
  }
  read(workspaceId: string, window: string): Promise<UsageSnapshot> {
    return Promise.resolve(this.rows.get(`${workspaceId}|${window}`) ?? EMPTY_USAGE);
  }
}

class FakeKillSwitch implements KillSwitchReader {
  private readonly engaged = new Set<string>();
  engage(workspaceId: string): void {
    this.engaged.add(workspaceId);
  }
  isEngaged(workspaceId: string): Promise<boolean> {
    return Promise.resolve(this.engaged.has(workspaceId));
  }
}

function cfg(scale: ScaleConfig): ResolvedConfig {
  return { ...CONFIG_DEFAULTS, scale };
}

const FIXED_NOW = (): Date => new Date("2026-06-09T00:00:00Z"); // window "2026-06"

function makeAdmission(
  scaleByTenant: Record<string, ScaleConfig>,
  over: Partial<AdmissionDeps> = {},
): { admission: Admission; usage: FakeUsage; kill: FakeKillSwitch } {
  const usage = new FakeUsage();
  const kill = new FakeKillSwitch();
  const admission = new Admission({
    usage,
    killSwitch: kill,
    config: (workspaceId) => cfg(scaleByTenant[workspaceId] ?? {}),
    globalMax: 0,
    now: FIXED_NOW,
    ...over,
  });
  return { admission, usage, kill };
}

// --- tests ------------------------------------------------------------------

describe("Admission (#71 — launch chokepoint: kill switch, budget, concurrency, placement)", () => {
  it("admits a launch under all caps and a release frees the slot", async () => {
    const { admission } = makeAdmission({ ws1: { tenantConcurrency: 1 } });
    const ticket = await admission.acquire("ws1");
    expect(admission.snapshot("ws1").tenant).toBe(1);

    // at the cap now — a second acquire is rejected
    await expect(admission.acquire("ws1")).rejects.toBeInstanceOf(AdmissionError);

    ticket.release();
    expect(admission.snapshot("ws1").tenant).toBe(0);
    // freed → admits again
    await expect(admission.acquire("ws1")).resolves.toBeDefined();
  });

  it("enforces the per-tenant cap independently per tenant", async () => {
    const { admission } = makeAdmission({
      ws1: { tenantConcurrency: 1 },
      ws2: { tenantConcurrency: 1 },
    });
    await admission.acquire("ws1");
    // ws1 is full but ws2 has its own budget
    await expect(admission.acquire("ws1")).rejects.toMatchObject({ reason: "tenant_capacity" });
    await expect(admission.acquire("ws2")).resolves.toBeDefined();
  });

  it("serializes concurrent acquires so exactly the tenant cap is admitted (#879)", async () => {
    const { admission } = makeAdmission({ ws1: { tenantConcurrency: 5 } });
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => admission.acquire("ws1")),
    );

    const admitted = attempts.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<Admission["acquire"]>>> =>
        result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(admitted).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((result) => result.reason?.reason === "tenant_capacity")).toBe(true);
    expect(admission.snapshot("ws1")).toMatchObject({ tenant: 5, global: 5 });

    for (const ticket of admitted) ticket.value.release();
    expect(admission.snapshot("ws1")).toMatchObject({ tenant: 0, global: 0 });
  });

  it("enforces the global ceiling across tenants", async () => {
    const { admission } = makeAdmission({}, { globalMax: 1 });
    await admission.acquire("ws1");
    await expect(admission.acquire("ws2")).rejects.toMatchObject({ reason: "global_capacity" });
  });

  it("the kill switch halts all launches for a tenant", async () => {
    const { admission, kill } = makeAdmission({});
    kill.engage("ws1");
    await expect(admission.acquire("ws1")).rejects.toMatchObject({ reason: "kill_switch" });
    // a different tenant is unaffected
    await expect(admission.acquire("ws2")).resolves.toBeDefined();
  });

  it("a budget breach halts new sessions (cost meets the cap)", async () => {
    const { admission, usage } = makeAdmission({ ws1: { budgetCents: 5000 } });
    usage.set("ws1", "2026-06", { estimatedCostCents: 5000 });
    await expect(admission.acquire("ws1")).rejects.toMatchObject({ reason: "budget_exceeded" });
    // under budget admits
    usage.set("ws1", "2026-06", { estimatedCostCents: 4999 });
    await expect(admission.acquire("ws1")).resolves.toBeDefined();
  });

  it("places a session in the least-loaded allowed region and frees it on release", async () => {
    const { admission } = makeAdmission({ ws1: { regions: ["iad1", "sfo1"] } });
    const t1 = await admission.acquire("ws1");
    expect(t1.region).toBe("iad1"); // both at 0 → allowed-order first
    const t2 = await admission.acquire("ws1");
    expect(t2.region).toBe("sfo1"); // iad1 now loaded → least-loaded is sfo1
    expect(admission.snapshot("ws1").byRegion).toEqual({ iad1: 1, sfo1: 1 });

    t1.release();
    expect(admission.snapshot("ws1").byRegion).toEqual({ iad1: 0, sfo1: 1 });
  });

  it("leaves the region undefined when no regions are configured (unplaced)", async () => {
    const { admission } = makeAdmission({ ws1: {} });
    const ticket = await admission.acquire("ws1");
    expect(ticket.region).toBeUndefined();
  });

  it("release is idempotent — a double release does not double-decrement", async () => {
    const { admission } = makeAdmission({ ws1: { regions: ["iad1"] } });
    const ticket = await admission.acquire("ws1");
    ticket.release();
    ticket.release();
    const snap = admission.snapshot("ws1");
    expect(snap.tenant).toBe(0);
    expect(snap.global).toBe(0);
    expect(snap.byRegion).toEqual({ iad1: 0 });
  });
});
