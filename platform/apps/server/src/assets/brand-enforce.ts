/**
 * Brand enforcement (#271) — this is MARK. PURE, no IO. Given the workspace's active brand kit and a
 * candidate asset, Mark decides whether it is on-brand and lists the specific violations. The service
 * uses this to BLOCK an off-brand `generate_image` result (and to stamp every stored asset with the kit
 * id it was checked against — provenance). The other agents (Quill/Echo/Bid) draw from the SAME kit, so
 * Mark's verdict is the single brand authority.
 *
 * The rule for an IMAGE is concrete + falsifiable: an image is on-brand iff a brand kit exists AND the
 * image was rendered with the brand's PRIMARY colour (it leads with the brand). Our dry-run generator
 * renders from the derived style, so a generated image passes by construction; an arbitrary upload that
 * ignores the palette fails — exactly what "Mark enforces" means. Copy is on-brand iff a kit exists and
 * the text is non-empty (the voice itself is advisory free-text, not a hard gate).
 */

import type { BrandKit, BrandCandidate, BrandEnforcement } from "./types.js";
import { isBrandKitComplete } from "./brand-kit.js";

/** The kit + its id, as the service supplies it to Mark (the id is stamped onto the checked asset). */
export interface ActiveBrandKit {
  id: string;
  kit: BrandKit;
}

/**
 * Mark's verdict. With no (complete) active kit, nothing can be on-brand — the only fix is to set the
 * brand kit, which is also what connects the brand proof tile. With a kit, an image must use the primary
 * brand colour; copy must be non-empty.
 */
export function enforceBrand(
  active: ActiveBrandKit | null,
  candidate: BrandCandidate,
): BrandEnforcement {
  if (!active || !isBrandKitComplete(active.kit)) {
    return {
      onBrand: false,
      violations: ["no brand kit set — set the brand kit (logo, colours, voice) before producing on-brand assets"],
      brandKitId: null,
    };
  }

  const { id, kit } = active;
  const violations: string[] = [];

  if (candidate.kind === "image") {
    const used = candidate.palette.map((c) => c.trim().toLowerCase());
    const primary = (kit.palette[0] as string).toLowerCase();
    if (!used.includes(primary)) {
      violations.push(`image does not use the primary brand colour ${primary}`);
    }
  } else {
    if (candidate.text.trim().length === 0) {
      violations.push("copy is empty — write the on-brand message");
    }
  }

  return { onBrand: violations.length === 0, violations, brandKitId: id };
}
