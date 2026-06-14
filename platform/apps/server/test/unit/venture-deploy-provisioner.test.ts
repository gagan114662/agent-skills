import { describe, it, expect } from "vitest";
import { VentureDeployProvisioner, ventureSlug } from "../../src/venture-deploy/provisioner.js";
import { DryRunInfraProvider } from "../../src/venture-deploy/dry-run-provider.js";
import { resolveVentureDeployCaps, type VentureDeployCaps } from "../../src/venture-deploy/caps.js";
import type { DeployTarget } from "../../src/venture-deploy/types.js";
import type { CreateDeployTargetInput, DeployTargetStore } from "../../src/venture-deploy/store.js";

function memTargetStore(): DeployTargetStore & { rows: DeployTarget[] } {
  const rows: DeployTarget[] = [];
  let seq = 0;
  return {
    rows,
    async getByVenture(workspaceId, ventureId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.ventureId === ventureId);
    },
    async create(input: CreateDeployTargetInput) {
      const row: DeployTarget = { id: `t${++seq}`, createdAt: new Date(0), ...input };
      rows.push(row);
      return row;
    },
  };
}

function caps(over: Partial<VentureDeployCaps> = {}): VentureDeployCaps {
  return { ...resolveVentureDeployCaps({ enabled: true }), ...over };
}

const input = {
  workspaceId: "ws1",
  ventureId: "11111111-2222-3333-4444-555555555555",
  ventureName: "Acme Widgets",
  createdByMemberId: "m1",
};

function build(over: {
  caps?: VentureDeployCaps;
  isOwner?: boolean;
  charge?: boolean;
  estimate?: number;
  infra?: DryRunInfraProvider;
} = {}) {
  const targets = memTargetStore();
  const infra = over.infra ?? new DryRunInfraProvider();
  const charges: number[] = [];
  const provisioner = new VentureDeployProvisioner({
    caps: () => over.caps ?? caps(),
    isOwnerWorkspace: async () => over.isOwner ?? true,
    targets,
    budget: {
      async charge(_ws, cents) {
        charges.push(cents);
        return over.charge ?? true;
      },
    },
    estimateSetupCents: over.estimate ?? 0,
    infra,
  });
  return { provisioner, targets, infra, charges };
}

describe("ventureSlug", () => {
  it("builds a DNS-safe, id-suffixed, globally-unique slug", () => {
    expect(ventureSlug("Acme Widgets!", "11111111-2222-3333-4444-555555555555")).toBe(
      "acme-widgets-11111111",
    );
  });
  it("falls back to 'venture' for an empty name", () => {
    expect(ventureSlug("", "abcd")).toBe("venture-abcd");
  });
});

describe("VentureDeployProvisioner (#195 AC1)", () => {
  it("provisions a tenant-scoped target for the owner workspace", async () => {
    const { provisioner, targets, infra } = build();
    await provisioner.provision(input);
    expect(infra.provisioned).toHaveLength(1);
    expect(targets.rows).toHaveLength(1);
    const t = targets.rows[0]!;
    expect(t.status).toBe("provisioned");
    expect(t.provider).toBe("dryrun");
    expect(t.prodUrl).toContain("dryrun.reload.app");
    expect(t.secretServiceKey).toBe(`venture-deploy:${input.ventureId}`);
  });

  it("is idempotent — a second provision short-circuits (infra not called twice)", async () => {
    const { provisioner, targets, infra } = build();
    await provisioner.provision(input);
    await provisioner.provision(input);
    expect(infra.provisioned).toHaveLength(1);
    expect(targets.rows).toHaveLength(1);
  });

  it("does nothing when the feature is disabled", async () => {
    const { provisioner, targets, infra } = build({ caps: resolveVentureDeployCaps(undefined) });
    await provisioner.provision(input);
    expect(infra.provisioned).toHaveLength(0);
    expect(targets.rows).toHaveLength(0);
  });

  it("respects ownerWorkspaceOnly for a non-owner workspace", async () => {
    const { provisioner, targets } = build({ isOwner: false });
    await provisioner.provision(input);
    expect(targets.rows).toHaveLength(0);
  });

  it("refuses provisioning when the budget ceiling is hit — no target created", async () => {
    const { provisioner, targets, infra } = build({ charge: false, estimate: 1000 });
    await provisioner.provision(input);
    expect(infra.provisioned).toHaveLength(0);
    expect(targets.rows).toHaveLength(0);
  });

  it("charges infra spend through the venture budget before provisioning", async () => {
    const { provisioner, charges } = build({ estimate: 250 });
    await provisioner.provision(input);
    expect(charges).toEqual([250]);
  });

  it("refuses an estimate over the hard per-venture cap", async () => {
    const { provisioner, targets } = build({
      caps: caps({ infraSetupCapCents: 100 }),
      estimate: 101,
    });
    await provisioner.provision(input);
    expect(targets.rows).toHaveLength(0);
  });

  it("swallows a provider failure (reversible — leaves the venture unprovisioned for retry)", async () => {
    const infra = new DryRunInfraProvider();
    infra.failNext = "fly down";
    const { provisioner, targets } = build({ infra });
    await provisioner.provision(input);
    expect(targets.rows).toHaveLength(0);
  });
});
