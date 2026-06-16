/**
 * Brand kit + asset store (#271) — pure data shapes. No IO here. These describe the brand identity the
 * owner sets once (palette/voice/logo) and the generated/uploaded assets the fleet draws from, plus the
 * verdict Mark returns when enforcing the brand on a candidate asset.
 */

/** How an asset entered the store. Mirrors the `workspace_assets.kind` enum. */
export type AssetKind = "generated" | "uploaded";

/** The tool/source that produced an asset. Mirrors `workspace_assets.source_tool`. */
export type AssetSourceTool = "generate_image" | "store_asset" | "upload";

/**
 * The validated brand identity. `palette` is an ordered list of normalised `#rrggbb` hex colours (first
 * = primary); `voice` is the tone + do/don't the copy must follow; `logoAssetId` is an optional soft ref
 * to an uploaded logo asset.
 */
export interface BrandKit {
  name: string;
  palette: string[];
  voice: string;
  logoAssetId: string | null;
}

/** The raw, owner-supplied brand kit before validation (any field may be missing/invalid). */
export interface BrandKitInput {
  name?: unknown;
  palette?: unknown;
  voice?: unknown;
  logoAssetId?: unknown;
}

/** The result of validating a {@link BrandKitInput}: either a clean kit or the list of reasons it failed. */
export type BrandKitValidation =
  | { ok: true; kit: BrandKit }
  | { ok: false; errors: string[] };

/**
 * The on-brand style derived from a kit — what the image provider renders with so a generated image is
 * on-brand by construction (it leads with the brand's primary colour and reflects the voice).
 */
export interface BrandImageStyle {
  /** The palette to render with (always non-empty when derived from a complete kit). */
  palette: string[];
  /** The primary (lead) brand colour. */
  primary: string;
  /** A short, single-line summary of the brand voice for the prompt. */
  voiceSummary: string;
}

/** A candidate asset Mark checks against the brand kit. An image carries the palette it was rendered with. */
export type BrandCandidate =
  | { kind: "image"; palette: string[] }
  | { kind: "copy"; text: string };

/** Mark's verdict on a candidate: on-brand or not, the specific violations, and the kit it was checked against. */
export interface BrandEnforcement {
  onBrand: boolean;
  violations: string[];
  /** The id of the active kit the candidate was checked against, or null when no kit is set. */
  brandKitId: string | null;
}
