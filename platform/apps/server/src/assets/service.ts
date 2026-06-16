/**
 * Asset store + image generation service (#271). The fleet's brand-asset surface, behind two safety
 * properties carried structurally:
 *
 *  1. **Money-only gating intact (#243).** `generateImage` is AUTONOMOUS — it never consults the #13
 *     approval gate. Generating an image is a fleet OPERATING cost (like the LLM tokens a session already
 *     spends), not a money action that moves the venture's money outward. The default provider is the
 *     no-network dry-run renderer, so by default there is literally zero spend. Outward/irreversible
 *     actions (publish/send) keep their #13 gates in `RealWorldActuatorService` — untouched here.
 *
 *  2. **Injection-quarantine intact (#223).** This service's dependency surface is the proof: it has a
 *     brand-kit store, an asset store, an image provider, and an (optional) receipt sink — and NO web
 *     reader / browse / send / spend seam. A poisoned web read therefore has no actuator to reach through
 *     this service, and the untrusted `prompt` is only ever XML-escaped into an SVG (DATA), never executed.
 *
 * Mark enforces the brand: every generated image is checked by {@link enforceBrand}; an off-brand result
 * is BLOCKED (never stored), and every stored asset is stamped with the brand-kit id it was checked
 * against (provenance).
 */

import type { ArtifactStore } from "../realworld/service.js";
import { enforceBrand, type ActiveBrandKit } from "./brand-enforce.js";
import { validateBrandKit } from "./brand-kit.js";
import { generateOnBrandImage, type ImageProvider } from "./image.js";
import type { AssetKind, AssetSourceTool, BrandKit, BrandKitInput } from "./types.js";

/** A persisted brand kit + identity/timestamps. */
export interface BrandKitRecord {
  id: string;
  kit: BrandKit;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Brand-kit persistence seam. `setActive` archives any prior active kit then inserts the new one. */
export interface BrandKitStore {
  getActive(workspaceId: string): Promise<BrandKitRecord | null>;
  setActive(workspaceId: string, kit: BrandKit): Promise<BrandKitRecord>;
}

/** The fields persisted for one stored asset. */
export interface StoredAssetInput {
  workspaceId: string;
  ventureId: string | null;
  kind: AssetKind;
  mime: string;
  title: string;
  data: string;
  brandKitId: string | null;
  onBrand: boolean;
  sourceTool: AssetSourceTool;
  draftRef: string | null;
  provider: string;
  detail: string;
}

export interface StoredAsset extends StoredAssetInput {
  id: string;
  createdAtMs: number;
}

/** Asset persistence + read seam (tenant-scoped by `workspaceId` at the repo). */
export interface AssetStore {
  insert(input: StoredAssetInput): Promise<StoredAsset>;
  list(workspaceId: string, limit?: number): Promise<StoredAsset[]>;
  count(workspaceId: string): Promise<number>;
}

export interface AssetServiceDeps {
  brandKits: BrandKitStore;
  assets: AssetStore;
  image: ImageProvider;
  /** Optional durable receipt sink (the realworld_artifacts feed). Absent ⇒ no receipt, behaviour same. */
  receipts?: ArtifactStore;
}

export type SetBrandKitResult =
  | { ok: true; record: BrandKitRecord }
  | { ok: false; errors: string[] };

export interface GenerateImageInput {
  workspaceId: string;
  ventureId?: string | null;
  /** The free-text description of the image (the agent's intent) — treated as opaque DATA. */
  prompt: string;
  /** Optional human title for the asset. */
  title?: string;
  /** Optional soft link to the `agent.deliverable` approval card (#248) this image is attached to. */
  draftRef?: string | null;
  width?: number;
  height?: number;
}

export type GenerateImageResult =
  | { status: "generated"; asset: StoredAsset }
  | { status: "rejected"; reason: string; violations: string[] };

export class AssetService {
  constructor(private readonly deps: AssetServiceDeps) {}

  /** The active brand kit + its id, in the shape Mark consumes. Null until the owner sets one. */
  async activeBrandKit(workspaceId: string): Promise<ActiveBrandKit | null> {
    const record = await this.deps.brandKits.getActive(workspaceId);
    return record ? { id: record.id, kit: record.kit } : null;
  }

  /** Validate + persist the brand kit the owner sets once. Re-setting archives the prior active kit. */
  async setBrandKit(workspaceId: string, input: BrandKitInput): Promise<SetBrandKitResult> {
    const validation = validateBrandKit(input);
    if (!validation.ok) return { ok: false, errors: validation.errors };
    const record = await this.deps.brandKits.setActive(workspaceId, validation.kit);
    return { ok: true, record };
  }

  /**
   * Generate an on-brand image and store it (autonomous — NO #13 gate; #243 money-only). Requires an
   * active brand kit: with none, Mark blocks it ("set the brand kit first"), which is also exactly what
   * connects the brand proof tile. The generated image is rendered FROM the kit's palette, then
   * re-checked by Mark before it is stored — an off-brand result is never persisted. A `draftRef`
   * soft-links the asset to the deliverable card it illustrates.
   */
  async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
    const active = await this.activeBrandKit(input.workspaceId);
    if (!active) {
      const verdict = enforceBrand(null, { kind: "image", palette: [] });
      return { status: "rejected", reason: verdict.violations[0] ?? "no brand kit set", violations: verdict.violations };
    }

    const result = await generateOnBrandImage(this.deps.image, active.kit, input.prompt, {
      width: input.width,
      height: input.height,
    });

    const verdict = enforceBrand(active, { kind: "image", palette: result.palette });
    if (!verdict.onBrand) {
      return { status: "rejected", reason: "generated image was off-brand", violations: verdict.violations };
    }

    const asset = await this.deps.assets.insert({
      workspaceId: input.workspaceId,
      ventureId: input.ventureId ?? null,
      kind: "generated",
      mime: result.mime,
      title: input.title?.trim() || input.prompt.trim().slice(0, 80),
      data: result.data,
      brandKitId: verdict.brandKitId,
      onBrand: true,
      sourceTool: "generate_image",
      draftRef: input.draftRef ?? null,
      provider: result.provider,
      detail: input.draftRef ? `on-brand image attached to draft ${input.draftRef}` : "on-brand image",
    });

    await this.recordReceipt(input.workspaceId, input.ventureId ?? null, result.provider, asset.detail);
    return { status: "generated", asset };
  }

  /** The workspace's stored assets, newest first (the Settings gallery + the brand tile feed). */
  listAssets(workspaceId: string, limit?: number): Promise<StoredAsset[]> {
    return this.deps.assets.list(workspaceId, limit);
  }

  /** Count of live brand assets — the brand proof tile's value once a kit is set (#253). */
  countAssets(workspaceId: string): Promise<number> {
    return this.deps.assets.count(workspaceId);
  }

  private async recordReceipt(
    workspaceId: string,
    ventureId: string | null,
    provider: string,
    detail: string,
  ): Promise<void> {
    if (!this.deps.receipts) return;
    await this.deps.receipts
      .record({
        workspaceId,
        ventureId,
        tool: "generate_image",
        url: null,
        provider,
        status: "published",
        approvalRequestId: null,
        detail,
      })
      .catch(() => undefined); // a receipt hiccup must never fail an otherwise-successful generation
  }
}
