import { describe, it, expect } from "vitest";
import {
  normalizeHex,
  validateBrandKit,
  isBrandKitComplete,
  deriveImageStyle,
} from "../../src/assets/brand-kit.js";
import type { BrandKit } from "../../src/assets/types.js";

describe("brand-kit (#271) — pure validation + derivation", () => {
  it("normalises valid #rrggbb hex to lowercase and rejects everything else", () => {
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
    expect(normalizeHex("  #123abc  ")).toBe("#123abc");
    expect(normalizeHex("#abc")).toBeNull(); // shorthand is ambiguous → rejected
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex("rgb(0,0,0)")).toBeNull();
    expect(normalizeHex(123)).toBeNull();
  });

  it("validates a clean kit, trimming the name + voice and de-duping the palette", () => {
    const logo = "11111111-1111-4111-8111-111111111111";
    const res = validateBrandKit({
      name: "  Acme  ",
      palette: ["#FF0000", "#ff0000", "#00FF00"],
      voice: "  Bold and friendly.  ",
      logoAssetId: logo,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kit.name).toBe("Acme");
    expect(res.kit.palette).toEqual(["#ff0000", "#00ff00"]); // duplicate collapsed, normalised
    expect(res.kit.voice).toBe("Bold and friendly.");
    expect(res.kit.logoAssetId).toBe(logo);
  });

  it("rejects a non-UUID logoAssetId (a uuid column would 500 on insert)", () => {
    const res = validateBrandKit({ name: "Acme", palette: ["#ff0000"], logoAssetId: "asset-1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContain("logoAssetId must be a valid UUID");
  });

  it("collects every failure reason at once (name + palette required, bad hex flagged)", () => {
    const res = validateBrandKit({ name: "  ", palette: ["nope"] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toContain("name is required");
    expect(res.errors.some((e) => e.includes("not a valid"))).toBe(true);
  });

  it("requires at least one colour", () => {
    const res = validateBrandKit({ name: "Acme", palette: [] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.some((e) => e.includes("at least one"))).toBe(true);
  });

  it("treats voice + logo as optional (a name + one colour is enough)", () => {
    const res = validateBrandKit({ name: "Acme", palette: ["#112233"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kit.voice).toBe("");
    expect(res.kit.logoAssetId).toBeNull();
  });

  it("isBrandKitComplete needs a name and ≥1 colour", () => {
    expect(isBrandKitComplete(null)).toBe(false);
    expect(isBrandKitComplete({ name: "Acme", palette: [], voice: "", logoAssetId: null })).toBe(false);
    expect(isBrandKitComplete({ name: "", palette: ["#000000"], voice: "", logoAssetId: null })).toBe(false);
    expect(isBrandKitComplete({ name: "Acme", palette: ["#000000"], voice: "", logoAssetId: null })).toBe(true);
  });

  it("derives an image style that leads with the primary colour", () => {
    const kit: BrandKit = { name: "Acme", palette: ["#ff0000", "#00ff00"], voice: "Bold.", logoAssetId: null };
    const style = deriveImageStyle(kit);
    expect(style.primary).toBe("#ff0000");
    expect(style.palette).toEqual(["#ff0000", "#00ff00"]);
    expect(style.voiceSummary).toBe("Bold.");
  });

  it("falls back to a brand-name voice summary when no voice is set", () => {
    const style = deriveImageStyle({ name: "Acme", palette: ["#ff0000"], voice: "", logoAssetId: null });
    expect(style.voiceSummary).toBe("Acme brand");
  });

  it("refuses to derive a style from an incomplete kit (programming guard)", () => {
    expect(() => deriveImageStyle({ name: "", palette: [], voice: "", logoAssetId: null })).toThrow(/incomplete/);
  });
});
