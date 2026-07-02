import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";

export interface ResolvedHostAddress {
  address: string;
  family?: number;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedHostAddress[]>;
export type PublicWebFetch = (input: string | URL, init?: UndiciRequestInit) => Promise<Response>;

export interface ValidatedPublicWebUrl {
  url: URL;
  hostname: string;
  address: string;
  family: 4 | 6;
}

export interface PinnedPublicWebResponse {
  response: Response;
  close(): Promise<void>;
}

export const defaultPublicWebFetch = undiciFetch as unknown as PublicWebFetch;

export async function defaultPublicWebHostResolver(
  hostname: string,
): Promise<ResolvedHostAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export function normalizePublicHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function extractRawAbsoluteHostname(rawUrl: string): string | null {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rawUrl.trim());
  if (!scheme) return null;
  const authority = rawUrl.trim().slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.split("@").at(-1) ?? "";
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    return end > 0 ? hostPort.slice(1, end) : hostPort;
  }
  const colonCount = (hostPort.match(/:/g) ?? []).length;
  return colonCount === 1 ? hostPort.slice(0, hostPort.lastIndexOf(":")) : hostPort;
}

export function isSuspiciousNumericHostLiteral(rawHostname: string): boolean {
  const host = normalizePublicHostname(rawHostname);
  if (host === "") return true;
  if (host.includes(":")) return false;
  if (host.startsWith("0x") || /^[0-9]+$/.test(host)) return true;

  const labels = host.split(".");
  const allNumericLike = labels.every((label) => /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(label));
  if (!allNumericLike) return false;
  if (labels.length !== 4) return true;
  return labels.some((label) => {
    if (!/^[0-9]+$/.test(label)) return true;
    if (label.length > 1 && label.startsWith("0")) return true;
    const value = Number(label);
    return !Number.isInteger(value) || value < 0 || value > 255;
  });
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return bytes as [number, number, number, number];
}

export function isBlockedPublicIpv4(address: string): boolean {
  const bytes = parseIpv4(address);
  if (!bytes) return true;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6(address: string): number[] | null {
  const zoneIndex = address.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;
  const lower = withoutZone.toLowerCase();
  const ipv4Match = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4Literal = ipv4Match?.[1];
  let normalized = lower;
  const embeddedIpv4 = ipv4Literal ? parseIpv4(ipv4Literal) : null;
  if (embeddedIpv4 && ipv4Literal) {
    const [a, b, c, d] = embeddedIpv4;
    normalized =
      lower.slice(0, -ipv4Literal.length) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const groups =
    halves.length === 2 ? [...left, ...Array<string>(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const words = groups.map((group) => Number.parseInt(group, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

export function isBlockedPublicIpv6(address: string): boolean {
  const bytes = expandIpv6(address);
  if (!bytes) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0) && !allZero;
  const nat64Mapped =
    first === 0x00 &&
    second === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible || nat64Mapped) {
    const embedded = bytes.slice(12, 16).join(".");
    return isBlockedPublicIpv4(embedded);
  }
  if (allZero || loopback) return true;
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if (first === 0xff) return true;
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  return false;
}

export function isBlockedPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedPublicIpv4(address);
  if (family === 6) return isBlockedPublicIpv6(address);
  return true;
}

export function isBlockedPublicHostnameLiteral(hostname: string): boolean {
  const host = normalizePublicHostname(hostname);
  if (host === "" || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    return true;
  if (isSuspiciousNumericHostLiteral(host)) return true;
  return isIP(host) !== 0 && isBlockedPublicAddress(host);
}

export function isAllowedPublicWebPort(url: URL): boolean {
  if (url.port === "") return true;
  if (url.protocol === "http:" && url.port === "80") return true;
  if (url.protocol === "https:" && url.port === "443") return true;
  return false;
}

export async function validatePublicWebUrl(
  rawUrl: string,
  resolver: HostResolver = defaultPublicWebHostResolver,
  base?: URL,
): Promise<ValidatedPublicWebUrl | null> {
  const rawHost = extractRawAbsoluteHostname(rawUrl);
  if (rawHost && isSuspiciousNumericHostLiteral(rawHost)) return null;

  let url: URL;
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isAllowedPublicWebPort(url)) return null;

  const hostname = normalizePublicHostname(url.hostname);
  if (isBlockedPublicHostnameLiteral(hostname)) return null;
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6)
    return { url, hostname, address: hostname, family: literalFamily };

  let resolved: readonly ResolvedHostAddress[];
  try {
    resolved = await resolver(hostname);
  } catch {
    return null;
  }
  if (resolved.length === 0) return null;
  if (resolved.some(({ address }) => isBlockedPublicAddress(address))) return null;
  const first = resolved[0];
  if (!first) return null;
  const family = isIP(first.address);
  if (family !== 4 && family !== 6) return null;
  return { url, hostname, address: first.address, family };
}

export function createPinnedPublicWebLookup(target: ValidatedPublicWebUrl): LookupFunction {
  return (hostname, _options, callback) => {
    const requested = normalizePublicHostname(hostname);
    if (requested !== target.hostname) {
      const err = new Error(
        "refusing DNS lookup for unvalidated host " + hostname,
      ) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      callback(err, "", target.family);
      return;
    }
    callback(null, target.address, target.family);
  };
}

export function createPinnedPublicWebDispatcher(target: ValidatedPublicWebUrl): Agent {
  return new Agent({
    connect: { lookup: createPinnedPublicWebLookup(target), family: target.family },
    keepAliveMaxTimeout: 1,
    keepAliveTimeout: 1,
  });
}

export async function fetchPinnedPublicWebUrl(
  target: ValidatedPublicWebUrl,
  init: UndiciRequestInit,
  fetchImpl: PublicWebFetch = defaultPublicWebFetch,
): Promise<PinnedPublicWebResponse> {
  const dispatcher = createPinnedPublicWebDispatcher(target);
  try {
    const response = await fetchImpl(target.url.href, { ...init, dispatcher });
    return {
      response,
      close: () => dispatcher.close(),
    };
  } catch (error) {
    dispatcher.destroy(error instanceof Error ? error : null);
    throw error;
  }
}

export async function readPublicWebResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const bytes = Number(contentLength);
    if (Number.isFinite(bytes) && bytes > maxBytes) return null;
  }

  if (!response.body) {
    const text = await response.text().catch(() => "");
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }
}
