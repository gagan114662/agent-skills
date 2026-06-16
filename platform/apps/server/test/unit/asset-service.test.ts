import { describe, it, expect } from "vitest";
import { AssetService } from "../../src/assets/service.js";
import type {
  AssetStore,
  BrandKitStore,
  BrandKitRecord,
  StoredAsset,
  StoredAssetInput,
} from "../../src/assets/service.js";
import type { ArtifactRecordInput, ArtifactStore } from "../../src/realworld/service.js";
import type { BrandKit } from "../../src/assets/types.js";
import { DryRunImageProvider } from "../../src/assets/image.js";

// --- fakes (no DB) ---------------------------------------------------------------------------------

function fakeBrandKits(initial?: { id: string; kit: BrandKit }): BrandKitStore & { active: BrandKitRecord | null } {
  const store = {
    active: initial
      ? { id: initial.id, kit: initial.kit, createdAtMs: 1, updatedAtMs: 1 }
      : (null as BrandKitRecord | null),
    async getActive() {
      return store.active;
    },
    async setActive(_workspaceId: string, kit: BrandKit) {
      store.active = { id: `kit-${(store.active?.id ?? "0").length}`, kit, createdAtMs: 2, updatedAtMs: 2 };
      return store.active;
    },
  };
  return store;
}

function fakeAssets(): AssetStore & { rows: StoredAsset[] } {
  const rows: StoredAsset[] = [];
  return {
    rows,
    async insert(input: StoredAssetInput) {
      const row: StoredAsset = { ...input, id: `asset-${rows.length + 1}`, createdAtMs: 10 + rows.length };
      rows.push(row);
      return row;
    },
    async list(_w, limit = 50) {
      return rows.slice(0, limit);
    },
    async count() {
      return rows.length;
    },
  };
}

function fakeReceipts(): ArtifactStore & { records: ArtifactRecordInput[] } {
  const records: ArtifactRecordInput[] = [];
  return {
    records,
    async record(i: ArtifactRecordInput) {
      records.push(i);
      return { id: `art-${records.length}` };
    },
  };
}

const KIT: BrandKit = { name: "Acme", palette: ["#ff0000", "#00ff00"], voice: "Bold.", logoAssetId: null };

describe("AssetService (#271)", () => {
  it("validates + persists the brand kit the owner sets, and rejects an invalid one", async () => {
    const brandKits = fakeBrandKits();
    const svc = new AssetService({ brandKits, assets: fakeAssets(), image: new DryRunImageProvider() });

    const bad = await svc.setBrandKit("w1", { name: "", palette: [] });
    expect(bad.ok).toBe(false);

    const good = await svc.setBrandKit("w1", { name: "Acme", palette: ["#ff0000"] });
    expect(good.ok).toBe(true);
    expect((await svc.activeBrandKit("w1"))?.kit.name).toBe("Acme");
  });

  it("BLOCKS image generation when no brand kit is set (Mark) — set the kit first", async () => {
    const svc = new AssetService({ brandKits: fakeBrandKits(), assets: fakeAssets(), image: new DryRunImageProvider() });
    const res = await svc.generateImage({ workspaceId: "w1", prompt: "Hero" });
    expect(res.status).toBe("rejected");
    if (res.status !== "rejected") return;
    expect(res.reason).toMatch(/set the brand kit/i);
  });

  it("generates an on-brand image, stores it stamped with the kit id + draft link, and writes a receipt", async () => {
    const brandKits = fakeBrandKits({ id: "kit-1", kit: KIT });
    const assets = fakeAssets();
    const receipts = fakeReceipts();
    const svc = new AssetService({ brandKits, assets, image: new DryRunImageProvider(), receipts });

    const res = await svc.generateImage({
      workspaceId: "w1",
      prompt: "Launch banner",
      draftRef: "draft-42",
      title: "Launch",
    });
    expect(res.status).toBe("generated");
    if (res.status !== "generated") return;

    expect(res.asset.kind).toBe("generated");
    expect(res.asset.sourceTool).toBe("generate_image");
    expect(res.asset.onBrand).toBe(true);
    expect(res.asset.brandKitId).toBe("kit-1");
    expect(res.asset.draftRef).toBe("draft-42");
    expect(res.asset.mime).toBe("image/svg+xml");
    expect(res.asset.data.startsWith("data:image/svg+xml;base64,")).toBe(true);

    // The asset was persisted, and a receipt landed in the realworld feed with the new tool name.
    expect(assets.rows).toHaveLength(1);
    expect(receipts.records.at(-1)).toMatchObject({ tool: "generate_image", status: "published" });
    expect(receipts.records.at(-1)?.detail).toMatch(/draft-42/);
  });

  it("is autonomous — generation has NO approval/gate dependency (money-only #243 preserved)", async () => {
    // The dependency surface is the proof: AssetServiceDeps has brandKits/assets/image/receipts and NO
    // approvals seam. A generate therefore completes with zero approval steps — it can't be money-gated.
    const svc = new AssetService({
      brandKits: fakeBrandKits({ id: "kit-1", kit: KIT }),
      assets: fakeAssets(),
      image: new DryRunImageProvider(),
    });
    const res = await svc.generateImage({ workspaceId: "w1", prompt: "x" });
    expect(res.status).toBe("generated"); // no pending_approval state exists on this path at all
  });

  it("counts + lists stored assets (the brand-tile + gallery feed)", async () => {
    const brandKits = fakeBrandKits({ id: "kit-1", kit: KIT });
    const assets = fakeAssets();
    const svc = new AssetService({ brandKits, assets, image: new DryRunImageProvider() });
    await svc.generateImage({ workspaceId: "w1", prompt: "a" });
    await svc.generateImage({ workspaceId: "w1", prompt: "b" });
    expect(await svc.countAssets("w1")).toBe(2);
    expect(await svc.listAssets("w1")).toHaveLength(2);
  });
});
