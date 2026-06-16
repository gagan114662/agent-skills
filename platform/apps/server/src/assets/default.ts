import { dbBrandKitStore, dbAssetStore } from "../db/repositories/assets.js";
import { dbArtifactStore } from "../db/repositories/realworld-artifacts.js";
import { resolveRealworldCaps } from "../realworld/caps.js";
import { loadConfig } from "../config/loader.js";
import { createImageProvider } from "./image.js";
import { AssetService } from "./service.js";

/**
 * Wire the {@link AssetService} to the real repos + the configured image provider (#271). The provider
 * defaults to the no-network dry-run renderer (`realworld.imageProvider`), so brand-asset generation
 * touches nothing external until an owner opts into a live provider. Receipts are written to the SAME
 * `realworld_artifacts` feed (#231) so a generated image shows up in the console's "real work" trail.
 *
 * NOTE the dependency surface — brand kits, assets, an image provider, a receipt sink — and the ABSENCE
 * of any web-reader/send/spend seam: that is the #223 injection-quarantine, preserved by construction.
 */
export function createDefaultAssetService(workspaceId: string): AssetService {
  const caps = resolveRealworldCaps(loadConfig(workspaceId).realworld);
  return new AssetService({
    brandKits: dbBrandKitStore,
    assets: dbAssetStore,
    image: createImageProvider(caps.imageProvider),
    receipts: dbArtifactStore,
  });
}
