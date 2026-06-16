/**
 * Image generation seam (#271). An {@link ImageProvider} turns a prompt + a derived on-brand style into
 * image bytes. The default {@link DryRunImageProvider} renders a DETERMINISTIC on-brand SVG locally — no
 * network, no spend, no API key — so the whole asset/brand flow is exercisable (and unit-testable) with
 * the surface default-OFF. A live provider (an external image API) is selected only when an owner opts
 * in via config; it stays out of this Stage-1 PR (see ADR-0271 / the follow-up issue) and the factory
 * fails safe on an unknown kind rather than silently degrading.
 *
 * No `Date`/`Math.random` here — the dry-run output is a pure function of (prompt, style, size), which
 * keeps generated assets reproducible and the tests stable.
 */

import type { BrandImageStyle } from "./types.js";
import { deriveImageStyle, isBrandKitComplete } from "./brand-kit.js";
import type { BrandKit } from "./types.js";

export interface ImageRequest {
  /** The free-text description of the image to generate (the agent's intent). */
  prompt: string;
  /** The on-brand style to render with (palette + voice), derived from the active brand kit. */
  style: BrandImageStyle;
  /** Pixel dimensions (defaults to a 1200×630 social card). */
  width?: number;
  height?: number;
}

export interface ImageResult {
  /** MIME type of {@link data} (the dry-run provider always returns `image/svg+xml`). */
  mime: string;
  /** The image as a `data:`/`https:` URI — what we persist in `workspace_assets.data`. */
  data: string;
  /** The palette the image was actually rendered with — Mark checks this for on-brand-ness. */
  palette: string[];
  /** The provider kind that produced the image (audit/provenance). */
  provider: string;
}

export interface ImageProvider {
  /** A short, stable kind label (audit/provenance). */
  readonly kind: string;
  generate(req: ImageRequest): Promise<ImageResult>;
}

/** XML-escape text destined for an SVG `<text>` node (the prompt is untrusted free-text). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a deterministic on-brand SVG: a primary-colour field with vertical accent bands drawn from the
 * rest of the palette, the brand voice summary, and the (truncated) prompt. Because it leads with
 * `style.primary`, Mark's image rule ("uses the primary brand colour") passes by construction.
 */
export function renderBrandSvg(req: ImageRequest): string {
  const width = req.width ?? 1200;
  const height = req.height ?? 630;
  const { palette, primary, voiceSummary } = req.style;
  const accents = palette.slice(1);
  // Constrain the accent bands to the RIGHT half so they never creep under the left-aligned text (which
  // is coloured for contrast against `primary`). With many palette colours a fixed band width would run
  // off-screen and cover the text; scaling by accent count keeps the left half a clean primary field.
  const bandWidth = accents.length > 0 ? width / 2 / accents.length : 0;
  const bands = accents
    .map((color, i) => {
      const x = width - bandWidth * (accents.length - i);
      return `<rect x="${x.toFixed(1)}" y="0" width="${bandWidth.toFixed(1)}" height="${height}" fill="${escapeXml(color)}" opacity="0.9"/>`;
    })
    .join("");
  // A readable foreground colour regardless of the primary's lightness.
  const ink = isLight(primary) ? "#111111" : "#ffffff";
  const promptLine = escapeXml(req.prompt.trim().slice(0, 120));
  const voiceLine = escapeXml(voiceSummary.slice(0, 80));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<rect width="${width}" height="${height}" fill="${escapeXml(primary)}"/>`,
    bands,
    `<text x="64" y="${height / 2}" font-family="system-ui,sans-serif" font-size="56" font-weight="700" fill="${ink}">${promptLine}</text>`,
    `<text x="64" y="${height / 2 + 64}" font-family="system-ui,sans-serif" font-size="28" fill="${ink}" opacity="0.85">${voiceLine}</text>`,
    `</svg>`,
  ].join("");
}

/** Crude relative-luminance test so the overlaid text stays legible on any primary colour. */
function isLight(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return false;
  const r = parseInt(m[1] as string, 16);
  const g = parseInt(m[2] as string, 16);
  const b = parseInt(m[3] as string, 16);
  // ITU-R BT.601 luma.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** The default provider: renders the on-brand SVG locally as a base64 data-uri. No network, no spend. */
export class DryRunImageProvider implements ImageProvider {
  readonly kind = "dryrun";
  async generate(req: ImageRequest): Promise<ImageResult> {
    const svg = renderBrandSvg(req);
    const data = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
    return { mime: "image/svg+xml", data, palette: req.style.palette, provider: this.kind };
  }
}

/**
 * Select the image provider by config kind. Defaults to the no-network dry-run renderer; a live external
 * image API is a follow-up (it would need a server/workspace key + spend accounting) and is rejected here
 * so an un-built provider fails safe instead of silently no-op'ing.
 */
export function createImageProvider(kind: string | undefined): ImageProvider {
  switch (kind ?? "dryrun") {
    case "dryrun":
      return new DryRunImageProvider();
    default:
      throw new Error(`image provider "${kind}" is not available yet (only "dryrun" is wired in this build)`);
  }
}

/** Convenience: derive the on-brand style from a kit and generate — the path the service uses. */
export async function generateOnBrandImage(
  provider: ImageProvider,
  kit: BrandKit,
  prompt: string,
  size?: { width?: number; height?: number },
): Promise<ImageResult> {
  if (!isBrandKitComplete(kit)) throw new Error("cannot generate an on-brand image without a complete brand kit");
  const style = deriveImageStyle(kit);
  return provider.generate({ prompt, style, width: size?.width, height: size?.height });
}
