import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  assertScreenshotQuality,
  checkLiveUrl,
  compareImages,
  decodePng,
} from "./visual-match-core.mjs";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 4, "ascii");
  data.copy(out, 8);
  // CRC is not needed by the verifier; keep it deterministic.
  out.writeUInt32BE(0, 8 + data.length);
  return out;
}

function png(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgb(x, y);
      const i = 1 + x * 3;
      row[i] = r;
      row[i + 1] = g;
      row[i + 2] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("visual-match-core (#1072)", () => {
  it("decodes RGB PNG screenshots and rejects blank captures", () => {
    const image = decodePng(png(4, 3, (x, y) => [x * 40, y * 60, 120]));
    expect(image.width).toBe(4);
    expect(image.height).toBe(3);
    expect(assertScreenshotQuality("sample", image, { minWidth: 4, minHeight: 3 })).toMatchObject({
      alphaPct: 1,
    });

    const blank = decodePng(png(4, 3, () => [255, 255, 255]));
    expect(() => assertScreenshotQuality("blank", blank, { minWidth: 4, minHeight: 3 })).toThrow(/blank/);
  });

  it("computes RMS and diff percentage for screenshot comparisons", () => {
    const a = decodePng(png(2, 1, () => [0, 0, 0]));
    const b = decodePng(png(2, 1, (x) => (x === 0 ? [0, 0, 0] : [30, 0, 0])));
    const diff = compareImages(a, b);
    expect(diff.diffPct).toBe(0.5);
    expect(diff.rms).toBeGreaterThan(0);
  });

  it("checks live routes only when the caller asks for live verification", async () => {
    const okFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => "<html>ipop Pricing</html>",
    });
    await expect(checkLiveUrl({ name: "pricing", url: "https://ipop.ai/pricing", contains: "Pricing" }, okFetch)).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      checkLiveUrl({ name: "pricing", url: "https://ipop.ai/pricing", contains: "Security" }, okFetch),
    ).rejects.toMatchObject({ message: expect.stringMatching(/required text/) });
  });
});
