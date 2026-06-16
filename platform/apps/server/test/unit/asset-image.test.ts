import { describe, it, expect } from "vitest";
import {
  DryRunImageProvider,
  createImageProvider,
  renderBrandSvg,
  generateOnBrandImage,
} from "../../src/assets/image.js";
import type { BrandKit } from "../../src/assets/types.js";

const kit: BrandKit = { name: "Acme", palette: ["#ff0000", "#00ff00", "#0000ff"], voice: "Bold.", logoAssetId: null };
const style = { palette: kit.palette, primary: "#ff0000", voiceSummary: "Bold." };

describe("DryRunImageProvider (#271) — deterministic on-brand SVG, no network", () => {
  it("renders an SVG that leads with the primary colour and returns the palette used", async () => {
    const out = await new DryRunImageProvider().generate({ prompt: "Launch banner", style });
    expect(out.mime).toBe("image/svg+xml");
    expect(out.provider).toBe("dryrun");
    expect(out.palette).toEqual(kit.palette);
    expect(out.data.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(out.data.split(",")[1] as string, "base64").toString("utf8");
    expect(svg).toContain(`fill="#ff0000"`); // primary as the background field
    expect(svg).toContain("Launch banner");
  });

  it("is deterministic — same input, byte-identical output (no Date/Math.random)", async () => {
    const a = await new DryRunImageProvider().generate({ prompt: "x", style });
    const b = await new DryRunImageProvider().generate({ prompt: "x", style });
    expect(a.data).toBe(b.data);
  });

  it("keeps accent bands in the right half even with a large palette (text stays legible)", () => {
    const wide = { palette: ["#ff0000", ...Array.from({ length: 10 }, (_, i) => `#0000${(i + 10).toString(16)}f`)], primary: "#ff0000", voiceSummary: "x" };
    const svg = renderBrandSvg({ prompt: "Hero", style: wide, width: 1200, height: 630 });
    const xs = [...svg.matchAll(/<rect x="([\d.]+)"/g)].map((m) => Number(m[1])).filter((x) => x > 0);
    // Every accent band starts at or past the horizontal midpoint, so none can cover the left-aligned text.
    expect(xs.length).toBeGreaterThan(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(600);
  });

  it("XML-escapes an untrusted prompt (it is DATA, never markup)", () => {
    const svg = renderBrandSvg({ prompt: `</text><script>alert(1)</script>`, style });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("generateOnBrandImage derives the style from the kit and renders on-brand", async () => {
    const out = await generateOnBrandImage(new DryRunImageProvider(), kit, "Hero");
    expect(out.palette[0]).toBe("#ff0000");
  });

  it("createImageProvider returns dryrun by default and fails safe on an unknown kind", () => {
    expect(createImageProvider(undefined).kind).toBe("dryrun");
    expect(createImageProvider("dryrun").kind).toBe("dryrun");
    expect(() => createImageProvider("openai")).toThrow(/not available yet/);
  });
});
