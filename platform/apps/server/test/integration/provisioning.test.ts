import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, closeDb } from "../../src/db/index.js";
import { workspaces } from "../../src/db/schema/index.js";
import { newId } from "../../src/db/id.js";
import {
  setServiceCredentials,
  resolveServiceSecrets,
  getServiceStatus,
} from "../../src/db/repositories/external-credentials.js";
import {
  dbProvisioningUsageStore,
  listProvisioningUsage,
} from "../../src/db/repositories/provisioning-usage.js";
import { ProvisioningService } from "../../src/provisioning/service.js";
import { resolveProvisioningCaps } from "../../src/provisioning/caps.js";
import { centralServiceKey } from "../../src/provisioning/registry.js";
import { verifiedCostCents } from "../../src/provisioning/usage.js";

/**
 * #267 — central provisioning, end-to-end on a real Postgres. Proves the parts unit tests (with fakes)
 * cannot:
 *  - a central provider key SEALED into the OWNER workspace vault (`central:<provider>`) is resolvable
 *    server-side by the provisioning service, while the customer workspace never holds it ("customer never
 *    sees a key" on a real vault);
 *  - a `customer_spend` capability returns ONLY the gating action — never a credential — even when a key
 *    exists in the vault;
 *  - the usage ledger round-trips and the billable total counts ONLY externally-grounded rows.
 *
 * Caps are forced on here (the layered-config gate is unit-tested separately) so the test is deterministic
 * and never mutates global env.
 */
const OWNER = `prov-owner-${newId()}`;
const CUSTOMER = `prov-cust-${newId()}`;
let ownerId = "";
let customerId = "";

beforeAll(async () => {
  const [owner] = await db.insert(workspaces).values({ slug: OWNER, name: OWNER }).returning();
  const [cust] = await db.insert(workspaces).values({ slug: CUSTOMER, name: CUSTOMER }).returning();
  ownerId = owner!.id;
  customerId = cust!.id;
  // ipop seals its CENTRAL provider key into the OWNER vault under `central:dataforseo` — not the customer's.
  await setServiceCredentials({
    workspaceId: ownerId,
    serviceKey: centralServiceKey("dataforseo"),
    secrets: { DATAFORSEO_API_KEY: "central-secret-xyz" },
  });
});

afterAll(async () => {
  await db.delete(workspaces).where(eq(workspaces.slug, OWNER));
  await db.delete(workspaces).where(eq(workspaces.slug, CUSTOMER));
  await closeDb();
});

function serviceFor(enabledWorkspaceId: string): ProvisioningService {
  // Provisioning is on, scoped to `enabledWorkspaceId`, with dataforseo mapped for keyword_data. The
  // central resolver reads the OWNER vault (not the calling tenant's), exactly like production wiring.
  const caps = resolveProvisioningCaps({
    enabled: true,
    ownerWorkspaceId: enabledWorkspaceId,
    providerByCapability: { keyword_data: "dataforseo" },
  });
  return new ProvisioningService({
    loadCaps: () => caps,
    central: { resolveCentral: (p) => resolveServiceSecrets(ownerId, centralServiceKey(p)) },
    centralConnected: async (p) =>
      (await getServiceStatus(ownerId, centralServiceKey(p)))?.connected === true,
    usage: dbProvisioningUsageStore,
  });
}

describe("provisioning (integration, real Postgres)", () => {
  it("resolves the central credential server-side from the OWNER vault", async () => {
    const svc = serviceFor(ownerId);
    const res = await svc.resolveCredential(ownerId, "keyword_data");
    expect(res.status).toBe("provisioned");
    if (res.status !== "provisioned") throw new Error("unreachable");
    expect(res.env).toEqual({ DATAFORSEO_API_KEY: "central-secret-xyz" });
  });

  it("the customer never holds the key — their own vault has nothing under the central service key", async () => {
    const customerVault = await resolveServiceSecrets(customerId, centralServiceKey("dataforseo"));
    expect(customerVault).toEqual({});
  });

  it("status read surface returns provisioned-connected WITHOUT exposing any key", async () => {
    const svc = serviceFor(ownerId);
    const statuses = await svc.status(ownerId);
    const json = JSON.stringify(statuses);
    expect(json).not.toContain("central-secret-xyz");
    expect(json).not.toContain("DATAFORSEO_API_KEY");
    expect(statuses.find((s) => s.capabilityId === "keyword_data")?.state).toBe("provisioned");
  });

  it("a customer-spend capability returns the gate action only — never a credential", async () => {
    const svc = serviceFor(ownerId);
    const res = await svc.resolveCredential(ownerId, "ads_spend");
    expect(res.status).toBe("customer_spend");
    if (res.status !== "customer_spend") throw new Error("unreachable");
    expect(res.actionType).toBe("provisioning.customer_spend");
    expect("env" in res).toBe(false);
  });

  it("usage ledger round-trips; billable total counts only externally-grounded rows", async () => {
    const svc = serviceFor(ownerId);
    await svc.meter({
      workspaceId: ownerId,
      capabilityId: "keyword_data",
      provider: "dataforseo",
      units: 3,
      costCents: 12,
      externalRef: "req-grounded",
    });
    await svc.meter({
      workspaceId: ownerId,
      capabilityId: "keyword_data",
      provider: "dataforseo",
      units: 1,
      costCents: 99,
      // no externalRef → an UNVERIFIED estimate
    });
    const rows = await listProvisioningUsage(ownerId);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    // Only the grounded $0.12 row counts toward the billable total — the $0.99 estimate does not.
    const mine = rows.filter((r) => r.capabilityId === "keyword_data");
    expect(verifiedCostCents(mine)).toBe(12);
  });
});
