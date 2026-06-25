import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = resolve(process.cwd(), "public");

async function bytes(path) {
  return readFile(resolve(publicDir, path));
}

describe("public social/install assets", () => {
  it("points the static head at the manifest and PNG social image", async () => {
    const html = await readFile(resolve(process.cwd(), "index.html"), "utf8");

    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('property="og:image" content="https://ipop.ai/og-image.png"');
    expect(html).toContain('property="og:image:type" content="image/png"');
    expect(html).toContain('name="twitter:image" content="https://ipop.ai/og-image.png"');
    expect(html).not.toContain("https://ipop.ai/og.svg");
  });

  it("serves a valid web manifest that points only at existing icon assets", async () => {
    const manifest = JSON.parse(await readFile(resolve(publicDir, "manifest.webmanifest"), "utf8"));

    expect(manifest.name).toBe("ipop");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.map((icon) => icon.src)).toEqual(["/favicon.svg", "/icon-192.png", "/icon-512.png"]);

    for (const icon of manifest.icons) {
      const body = await bytes(icon.src.slice(1));
      expect(body.byteLength, icon.src).toBeGreaterThan(100);
    }
  });

  it("ships a real PNG Open Graph image instead of relying on the SPA fallback", async () => {
    const image = await bytes("og-image.png");
    const pngSignature = image.subarray(0, 8).toString("hex");
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);

    expect(pngSignature).toBe("89504e470d0a1a0a");
    expect({ width, height }).toEqual({ width: 1200, height: 630 });
    expect(image.byteLength).toBeGreaterThan(10_000);
    expect(image.subarray(0, 200).toString("utf8")).not.toContain("<!doctype html>");
  });
});
