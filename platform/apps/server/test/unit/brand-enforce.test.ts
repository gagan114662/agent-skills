import { describe, it, expect } from "vitest";
import { enforceBrand, type ActiveBrandKit } from "../../src/assets/brand-enforce.js";

const active: ActiveBrandKit = {
  id: "kit-1",
  kit: { name: "Acme", palette: ["#ff0000", "#00ff00"], voice: "Bold.", logoAssetId: null },
};

describe("enforceBrand (#271) — Mark's brand authority", () => {
  it("blocks everything when no brand kit is set, telling the owner to set one", () => {
    const verdict = enforceBrand(null, { kind: "image", palette: ["#ff0000"] });
    expect(verdict.onBrand).toBe(false);
    expect(verdict.brandKitId).toBeNull();
    expect(verdict.violations[0]).toMatch(/set the brand kit/i);
  });

  it("blocks an off-brand kit (no colours) the same way", () => {
    const verdict = enforceBrand(
      { id: "x", kit: { name: "Acme", palette: [], voice: "", logoAssetId: null } },
      { kind: "image", palette: ["#ff0000"] },
    );
    expect(verdict.onBrand).toBe(false);
  });

  it("passes an image that leads with the primary brand colour, stamping the kit id", () => {
    const verdict = enforceBrand(active, { kind: "image", palette: ["#FF0000", "#123456"] });
    expect(verdict.onBrand).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.brandKitId).toBe("kit-1");
  });

  it("blocks an image that ignores the primary brand colour", () => {
    const verdict = enforceBrand(active, { kind: "image", palette: ["#00ff00", "#0000ff"] });
    expect(verdict.onBrand).toBe(false);
    expect(verdict.violations[0]).toMatch(/primary brand colour #ff0000/);
    expect(verdict.brandKitId).toBe("kit-1"); // still stamped — it WAS checked against this kit
  });

  it("passes non-empty copy and blocks empty copy", () => {
    expect(enforceBrand(active, { kind: "copy", text: "Launch day!" }).onBrand).toBe(true);
    const empty = enforceBrand(active, { kind: "copy", text: "   " });
    expect(empty.onBrand).toBe(false);
    expect(empty.violations[0]).toMatch(/empty/);
  });
});
