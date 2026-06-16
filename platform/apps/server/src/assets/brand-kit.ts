/**
 * Brand kit validation + derivation (#271) — PURE, no IO, no clock. The owner sets the brand identity
 * once; this module turns their raw input into a clean {@link BrandKit} (or the list of reasons it's
 * invalid) and derives the on-brand image style the fleet renders with. Unit-tested without a DB.
 */

import type { BrandKit, BrandKitInput, BrandKitValidation, BrandImageStyle } from "./types.js";

/** A `#rrggbb` hex colour (the only palette form we store — shorthand/`rgb()` are rejected as ambiguous). */
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Canonical UUID form — `logo_asset_id` is a uuid column, so a non-UUID would 500 on insert. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME = 80;
const MAX_VOICE = 2000;
const MAX_PALETTE = 12;

/** Normalise a hex colour to lowercase `#rrggbb`, or null if it isn't a valid 6-digit hex. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return HEX_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Validate a raw owner-supplied brand kit. A valid kit needs a non-empty name and at least one valid hex
 * colour; the voice is optional copy (capped). Duplicate colours are collapsed (first occurrence wins) so
 * the palette stays a clean, ordered set. Returns every failure reason at once (not just the first).
 */
export function validateBrandKit(input: BrandKitInput): BrandKitValidation {
  const errors: string[] = [];

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name is required");
  else if (name.length > MAX_NAME) errors.push(`name must be ${MAX_NAME} characters or fewer`);

  const rawPalette = Array.isArray(input.palette) ? input.palette : [];
  if (rawPalette.length === 0) {
    errors.push("palette must include at least one #rrggbb colour");
  }
  const palette: string[] = [];
  for (const raw of rawPalette) {
    const hex = normalizeHex(raw);
    if (!hex) {
      errors.push(`"${String(raw)}" is not a valid #rrggbb hex colour`);
      continue;
    }
    if (!palette.includes(hex)) palette.push(hex);
  }
  if (palette.length > MAX_PALETTE) {
    errors.push(`palette must have ${MAX_PALETTE} colours or fewer`);
  }

  const voice = typeof input.voice === "string" ? input.voice.trim() : "";
  if (voice.length > MAX_VOICE) errors.push(`voice must be ${MAX_VOICE} characters or fewer`);

  let logoAssetId: string | null = null;
  if (typeof input.logoAssetId === "string" && input.logoAssetId.trim()) {
    const trimmed = input.logoAssetId.trim();
    if (UUID_RE.test(trimmed)) logoAssetId = trimmed;
    else errors.push("logoAssetId must be a valid UUID");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, kit: { name, palette, voice, logoAssetId } };
}

/**
 * Whether a kit is complete enough to enforce + render on-brand assets: a name and at least one colour.
 * (The voice + logo are optional — the brand tile connects on a complete-enough kit, not a perfect one.)
 */
export function isBrandKitComplete(kit: BrandKit | null | undefined): kit is BrandKit {
  return !!kit && kit.name.trim().length > 0 && kit.palette.length > 0;
}

/**
 * Derive the on-brand image style from a complete kit — the palette to render with, the lead colour, and
 * a one-line voice summary. The provider renders the generated image FROM this style so the output is
 * on-brand by construction (it leads with the primary colour). Throws on an incomplete kit (call
 * {@link isBrandKitComplete} first); a thrown error here is a programming bug, not user input.
 */
export function deriveImageStyle(kit: BrandKit): BrandImageStyle {
  if (!isBrandKitComplete(kit)) throw new Error("cannot derive an image style from an incomplete brand kit");
  const primary = kit.palette[0] as string;
  const voiceSummary = kit.voice.trim().replace(/\s+/g, " ").slice(0, 200) || `${kit.name} brand`;
  return { palette: kit.palette, primary, voiceSummary };
}
