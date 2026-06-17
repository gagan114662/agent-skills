import { describe, it, expect } from "vitest";
import {
  ProvisioningService,
  type UsageStore,
  type ProvisioningServiceDeps,
} from "../../src/provisioning/service.js";
import { resolveProvisioningCaps, type ProvisioningCaps } from "../../src/provisioning/caps.js";
import { StaticCentralCredentialResolver, EmptyCentralCredentialResolver } from "../../src/provisioning/provider.js";
import type { UsageRecord } from "../../src/provisioning/usage.js";

const OWNER = "ws-owner";

function makeService(
  caps: ProvisioningCaps,
  opts: Partial<ProvisioningServiceDeps> & { recorded?: UsageRecord[] } = {},
): { svc: ProvisioningService; recorded: UsageRecord[] } {
  const recorded: UsageRecord[] = opts.recorded ?? [];
  const usage: UsageStore = { record: async (r) => void recorded.push(r) };
  const svc = new ProvisioningService({
    loadCaps: () => caps,
    central: opts.central ?? new EmptyCentralCredentialResolver(),
    centralConnected: opts.centralConnected ?? (async () => false),
    usage,
    now: opts.now ?? (() => 1000),
  });
  return { svc, recorded };
}

const enabled = resolveProvisioningCaps({ enabled: true, ownerWorkspaceId: OWNER });

describe("ProvisioningService", () => {
  it("resolveCredential returns server-side env for a connected central provider", async () => {
    const { svc } = makeService(enabled, {
      central: new StaticCentralCredentialResolver({ mock: { DATA_API_KEY: "secret-xyz" } }),
    });
    const res = await svc.resolveCredential(OWNER, "keyword_data");
    expect(res.status).toBe("provisioned");
    if (res.status !== "provisioned") throw new Error("unreachable");
    expect(res.env).toEqual({ DATA_API_KEY: "secret-xyz" });
    expect(res.provider).toBe("mock");
  });

  it("degrades to `unavailable` (not failure) when the central credential is not connected", async () => {
    const { svc } = makeService(enabled, { central: new EmptyCentralCredentialResolver() });
    const res = await svc.resolveCredential(OWNER, "keyword_data");
    expect(res.status).toBe("unavailable");
  });

  it("degrades to `unavailable` (no crash) when the resolver returns null/undefined", async () => {
    const { svc } = makeService(enabled, {
      central: { resolveCentral: async () => null as unknown as Record<string, string> },
    });
    const res = await svc.resolveCredential(OWNER, "keyword_data");
    expect(res.status).toBe("unavailable");
  });

  it("a customer-spend capability NEVER returns a credential — only the gating action", async () => {
    const { svc } = makeService(enabled, {
      central: new StaticCentralCredentialResolver({ mock: { K: "v" } }),
    });
    const res = await svc.resolveCredential(OWNER, "ads_spend");
    expect(res.status).toBe("customer_spend");
    if (res.status !== "customer_spend") throw new Error("unreachable");
    expect(res.actionType).toBe("provisioning.customer_spend");
    expect("env" in res).toBe(false);
  });

  it("a disabled workspace gets no credential (adapter falls back to mock)", async () => {
    const { svc } = makeService(resolveProvisioningCaps(undefined));
    const res = await svc.resolveCredential("any-ws", "keyword_data");
    expect(res.status).toBe("disabled");
  });

  it("status read surface NEVER exposes a key — only provider id + a human detail", async () => {
    const { svc } = makeService(enabled, {
      central: new StaticCentralCredentialResolver({ mock: { DATA_API_KEY: "secret-xyz" } }),
      centralConnected: async () => true,
    });
    const statuses = await svc.status(OWNER);
    const json = JSON.stringify(statuses);
    expect(json).not.toContain("secret-xyz");
    expect(json).not.toContain("DATA_API_KEY");

    const keyword = statuses.find((s) => s.capabilityId === "keyword_data");
    expect(keyword?.state).toBe("provisioned");
    expect(keyword?.provider).toBe("mock");

    const adBudget = statuses.find((s) => s.capabilityId === "ads_spend");
    expect(adBudget?.state).toBe("customer_spend");
    expect(adBudget?.provider).toBeNull();
  });

  it("status shows `unavailable` when provisioned in policy but the key isn't connected", async () => {
    const { svc } = makeService(enabled, { centralConnected: async () => false });
    const statuses = await svc.status(OWNER);
    expect(statuses.find((s) => s.capabilityId === "serp_data")?.state).toBe("unavailable");
  });

  it("status for a disabled workspace shows every platform capability `disabled`", async () => {
    const { svc } = makeService(resolveProvisioningCaps(undefined));
    const statuses = await svc.status("any-ws");
    const platform = statuses.filter((s) => s.costClass === "platform_cost");
    expect(platform.every((s) => s.state === "disabled")).toBe(true);
  });

  it("meter records one usage row, deriving verified from the receipt", async () => {
    const { svc, recorded } = makeService(enabled);
    const row = await svc.meter({
      workspaceId: OWNER,
      capabilityId: "serp_data",
      provider: "dataforseo",
      units: 2,
      costCents: 8,
      externalRef: "req_42",
    });
    expect(row.verified).toBe(true);
    expect(row.occurredAtMs).toBe(1000);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toEqual(row);
  });
});
