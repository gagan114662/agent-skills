import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePng(buffer) {
  assert(buffer.subarray(0, 8).equals(PNG_SIGNATURE), "not a PNG file");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      assert(bitDepth === 8, "only 8-bit PNG screenshots are supported");
      assert(colorType === 2 || colorType === 6, "only RGB/RGBA PNG screenshots are supported");
      assert(interlace === 0, "interlaced PNG screenshots are not supported");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  assert(width > 0 && height > 0, "PNG is missing IHDR dimensions");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let rawOffset = 0;
  let outOffset = 0;
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const row = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= channels ? prev[x - channels] ?? 0 : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else assert(filter === 0, `unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const i = x * channels;
      pixels[outOffset++] = row[i];
      pixels[outOffset++] = row[i + 1];
      pixels[outOffset++] = row[i + 2];
      pixels[outOffset++] = channels === 4 ? row[i + 3] : 255;
    }
    prev = row;
  }

  return { width, height, pixels };
}

export async function readPng(path) {
  const buffer = await readFile(path);
  return { ...decodePng(buffer), bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

export function imageStats(image) {
  let alphaPixels = 0;
  let min = 255;
  let max = 0;
  let sum = 0;
  const total = image.width * image.height;
  for (let i = 0; i < image.pixels.length; i += 4) {
    const r = image.pixels[i];
    const g = image.pixels[i + 1];
    const b = image.pixels[i + 2];
    const a = image.pixels[i + 3];
    const luminance = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
    sum += luminance;
    if (a > 0) alphaPixels += 1;
  }
  return {
    alphaPct: alphaPixels / total,
    luminanceMin: min,
    luminanceMax: max,
    luminanceMean: sum / total,
  };
}

export function compareImages(reference, candidate) {
  assert(reference.width === candidate.width, `width mismatch: expected ${reference.width}, got ${candidate.width}`);
  assert(reference.height === candidate.height, `height mismatch: expected ${reference.height}, got ${candidate.height}`);
  let squared = 0;
  let changed = 0;
  const channels = reference.width * reference.height * 4;
  for (let i = 0; i < channels; i += 4) {
    const dr = reference.pixels[i] - candidate.pixels[i];
    const dg = reference.pixels[i + 1] - candidate.pixels[i + 1];
    const db = reference.pixels[i + 2] - candidate.pixels[i + 2];
    squared += dr * dr + dg * dg + db * db;
    if (dr !== 0 || dg !== 0 || db !== 0) changed += 1;
  }
  const pixels = reference.width * reference.height;
  return {
    rms: Math.sqrt(squared / (pixels * 3)),
    diffPct: changed / pixels,
  };
}

export function assertScreenshotQuality(name, image, opts = {}) {
  const stats = imageStats(image);
  const minWidth = opts.minWidth ?? 320;
  const minHeight = opts.minHeight ?? 240;
  const minLuminanceSpread = opts.minLuminanceSpread ?? 12;
  assert(image.width >= minWidth, `${name}: width ${image.width} is below ${minWidth}`);
  assert(image.height >= minHeight, `${name}: height ${image.height} is below ${minHeight}`);
  assert(stats.alphaPct > 0.99, `${name}: screenshot is mostly transparent/empty`);
  assert(stats.luminanceMax - stats.luminanceMin >= minLuminanceSpread, `${name}: screenshot appears blank`);
  return stats;
}

export async function checkLiveUrl(check, fetchImpl = fetch) {
  const response = await fetchImpl(check.url, { redirect: "follow" });
  assert(response.ok, `${check.name}: ${check.url} returned HTTP ${response.status}`);
  const text = await response.text();
  if (check.contains) {
    assert(text.includes(check.contains), `${check.name}: live response did not include required text`);
  }
  return { status: response.status, bytes: text.length };
}
