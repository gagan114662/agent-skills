import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outcome-first onboarding deliverable (issue #633).
 *
 * The first thing a brand-new visitor should see is a *real, personalized artifact* about their business —
 * not a setup checklist. They type a URL; we immediately produce a concrete first-week growth teardown and
 * stream it in live (see the SSE route in `routes/onboarding.ts`), while the Google sign-in / config happens
 * in parallel (never as a gate). Acceptance: a deliverable appears within ~60s with zero required setup.
 *
 * This module is deliberately DB-free but not fake: it fetches the public homepage, distills bounded facts,
 * and refuses to return a polished-looking artifact when the site cannot be read. The URL is UNTRUSTED input
 * (#200): we parse it structurally, reject local/private hosts, fetch only http(s), strip markup, and render
 * derived strings as text downstream, never as HTML.
 */

/** A business identity derived purely from the typed URL. */
export interface DeliverableBusiness {
  /** The normalized canonical URL we echo back (always `https://`, host lower-cased). */
  url: string;
  /** The bare host, `www.` stripped (e.g. `acme.com`). */
  host: string;
  /** A human brand name derived from the host's first label, title-cased (e.g. `Acme`). */
  name: string;
}

export interface SiteSnapshot {
  /** The final URL that responded, after redirects. */
  sourceUrl: string;
  /** HTTP status from the readable response. */
  status: number;
  title?: string;
  description?: string;
  h1?: string;
  ctas: string[];
  keywords: string[];
}

/** One block of the deliverable. `kind` lets the UI badge/style it (insight vs. action vs. draft). */
export interface DeliverableSection {
  id: string;
  kind: "insight" | "action" | "draft";
  heading: string;
  body: string;
}

/** The full artifact: a header plus ordered sections, ready to stream section-by-section. */
export interface DeliverablePlan {
  business: DeliverableBusiness;
  siteRead: SiteSnapshot;
  title: string;
  subtitle: string;
  sections: DeliverableSection[];
}

/** Max characters we accept for a typed URL — well past any real domain, a cheap abuse clamp. */
const MAX_URL_LEN = 2048;
/** Max characters for the derived brand name before we truncate (keeps headings sane). */
const MAX_NAME_LEN = 40;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_TEXT_CHARS = 220;
const MAX_CTA_COUNT = 5;
const MAX_KEYWORDS = 6;
const MAX_REDIRECTS = 5;

export interface ResolvedHostAddress {
  address: string;
  family?: number;
}

export type HostResolver = (hostname: string) => Promise<readonly ResolvedHostAddress[]>;

export type SiteSnapshotReader = (business: DeliverableBusiness) => Promise<SiteSnapshot | null>;

/**
 * Parse + normalize an untrusted typed URL into a {@link DeliverableBusiness}, or `null` when it cannot be
 * read as a web address. Accepts bare domains (`acme.com`), `with-path/slug`, and full `https://…` URLs.
 * We only keep `http`/`https`; anything else (`javascript:`, `file:`, `data:`) is rejected outright.
 */
export function deriveBusiness(raw: unknown): DeliverableBusiness | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > MAX_URL_LEN) return null;

  // Prepend a scheme so the URL parser accepts a bare domain; reject anything with a non-web scheme.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  // A host must look like a public domain (at least one dot, only domain-legal chars) — drops localhost/junk.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (isBlockedHost(host)) return null;

  const name = brandNameFromHost(host);
  if (!name) return null;

  return { url: `https://${host}${parsed.pathname === "/" ? "" : parsed.pathname}`, host, name };
}

function isBlockedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^\d+(\.\d+){3}$/.test(host)) return true;
  if (host === "0.0.0.0") return true;
  return false;
}

async function defaultResolveHost(hostname: string): Promise<ResolvedHostAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function extractRawAbsoluteHostname(rawUrl: string): string | null {
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

function isSuspiciousNumericHostLiteral(rawHostname: string): boolean {
  const host = normalizeHost(rawHostname);
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

function isBlockedIpv4(address: string): boolean {
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
  let normalized = lower;
  const embeddedIpv4 = ipv4Match?.[1] ? parseIpv4(ipv4Match[1]) : null;
  if (embeddedIpv4) {
    const [a, b, c, d] = embeddedIpv4;
    normalized =
      lower.slice(0, -ipv4Match[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array<string>(missing).fill("0"), ...right] : left;
  if (groups.length !== 8) return null;
  const words = groups.map((group) => Number.parseInt(group, 16));
  if (words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  const bytes: number[] = [];
  for (const word of words) {
    bytes.push((word >> 8) & 0xff, word & 0xff);
  }
  return bytes;
}

function isBlockedIpv6(address: string): boolean {
  const bytes = expandIpv6(address);
  if (!bytes) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0) && !allZero;
  if (ipv4Mapped || ipv4Compatible) {
    const embedded = bytes.slice(12, 16).join(".");
    return isBlockedIpv4(embedded);
  }
  if (allZero || loopback) return true;
  if ((first & 0xfe) === 0xfc) return true;
  if (first === 0xfe && (second & 0xc0) === 0x80) return true;
  if (first === 0xff) return true;
  if (first === 0x20 && second === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  return false;
}

function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function isAllowedWebPort(url: URL): boolean {
  if (url.port === "") return true;
  if (url.protocol === "http:" && url.port === "80") return true;
  if (url.protocol === "https:" && url.port === "443") return true;
  return false;
}

async function validateFetchUrl(rawUrl: string, resolver: HostResolver, base?: URL): Promise<URL | null> {
  const rawHost = extractRawAbsoluteHostname(rawUrl);
  if (rawHost && isSuspiciousNumericHostLiteral(rawHost)) return null;

  let url: URL;
  try {
    url = base ? new URL(rawUrl, base) : new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!isAllowedWebPort(url)) return null;

  const hostname = normalizeHost(url.hostname);
  if (hostname === "" || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return null;
  }

  if (isSuspiciousNumericHostLiteral(hostname)) return null;
  if (isIP(hostname)) return isBlockedAddress(hostname) ? null : url;

  let resolved: readonly ResolvedHostAddress[];
  try {
    resolved = await resolver(hostname);
  } catch {
    return null;
  }
  if (resolved.length === 0) return null;
  return resolved.some(({ address }) => isBlockedAddress(address)) ? null : url;
}

/** Title-case the host's first label into a brand name, stripping anything not letter/number/space/hyphen. */
export function brandNameFromHost(host: string): string {
  const label = host.split(".")[0]?.replace(/[^a-z0-9- ]/gi, "").replace(/-+/g, " ").trim() ?? "";
  if (label === "") return "";
  const titled = label
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return titled.slice(0, MAX_NAME_LEN);
}

export async function readSiteSnapshot(
  business: DeliverableBusiness,
  fetchImpl: typeof fetch = fetch,
  resolver: HostResolver = defaultResolveHost,
): Promise<SiteSnapshot | null> {
  const primary = business.url;
  const fallback = primary.replace(/^https:/, "http:");
  for (const url of primary === fallback ? [primary] : [primary, fallback]) {
    const snapshot = await fetchSnapshotUrl(url, fetchImpl, resolver);
    if (snapshot) return snapshot;
  }
  return null;
}

async function fetchSnapshotUrl(url: string, fetchImpl: typeof fetch, resolver: HostResolver): Promise<SiteSnapshot | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = await validateFetchUrl(url, resolver);
    if (!current) return null;
    let res: Response | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      res = await fetchImpl(current.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "ipop-onboarding-site-reader/1.0",
        },
      });
      if (res.status < 300 || res.status > 399) break;
      const location = res.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) return null;
      const next = await validateFetchUrl(location, resolver, current);
      if (!next) return null;
      current = next;
    }
    if (!res) return null;
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
    const html = (await res.text().catch(() => "")).slice(0, MAX_HTML_BYTES);
    return parseSiteSnapshot(res.url || current.href, res.status, html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function parseSiteSnapshot(sourceUrl: string, status: number, html: string): SiteSnapshot | null {
  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const h1 = extractFirstHeading(html, "h1");
  const ctas = extractCtas(html);
  const keywords = extractKeywords([title, description, h1, ...ctas].filter(Boolean).join(" "));
  if (!title && !description && !h1 && ctas.length === 0) return null;
  return {
    sourceUrl: sanitizeUrl(sourceUrl),
    status,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(h1 ? { h1 } : {}),
    ctas,
    keywords,
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : " ";
    });
}

function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code <= 0x1f || code === 0x7f;
}

function replaceControlChars(text: string): string {
  return Array.from(text, (char) => (isControlChar(char) ? " " : char)).join("");
}

function cleanText(text: string, max = MAX_TEXT_CHARS): string {
  return replaceControlChars(decodeEntities(text))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeUrl(url: string): string {
  return Array.from(url)
    .filter((char) => !isControlChar(char) && char.trim() !== "")
    .join("")
    .slice(0, 300);
}

function extractTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text = match?.[1] ? cleanText(stripHtml(match[1])) : "";
  return text || undefined;
}

function extractMetaDescription(html: string): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/(name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag)) continue;
    const match = /content\s*=\s*"([^"]*)"/i.exec(tag) ?? /content\s*=\s*'([^']*)'/i.exec(tag);
    const text = match?.[1] ? cleanText(match[1], 280) : "";
    if (text) return text;
  }
  return undefined;
}

function extractFirstHeading(html: string, tag: "h1" | "h2"): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  const text = match?.[1] ? cleanText(stripHtml(match[1])) : "";
  return text || undefined;
}

function extractCtas(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < MAX_CTA_COUNT) {
    const text = cleanText(stripHtml(match[2] ?? ""), 60);
    if (!text || text.length < 3 || text.length > 60) continue;
    if (!/\b(start|try|book|get|join|demo|contact|buy|learn|sign|talk|request|download)\b/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function extractKeywords(text: string): string[] {
  const stop = new Set(["the", "and", "for", "with", "your", "you", "that", "this", "from", "into", "are", "our", "their"]);
  const words = cleanText(text, 800)
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => (/\p{Script=Han}/u.test(word) ? Array.from(word).length >= 2 : word.length > 3) && !stop.has(word));
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KEYWORDS)
    .map(([word]) => word);
}

export async function buildDeliverableForBusiness(
  business: DeliverableBusiness,
  readSnapshot: SiteSnapshotReader = readSiteSnapshot,
): Promise<DeliverablePlan | null> {
  const snapshot = await readSnapshot(business);
  return snapshot ? buildDeliverable(business, snapshot) : null;
}

/**
 * Build the personalized deliverable for a business from facts we actually read from its public site.
 * Deterministic for a given `{business, snapshot}` pair; never fabricates crawled details.
 */
export function buildDeliverable(business: DeliverableBusiness, snapshot: SiteSnapshot): DeliverablePlan {
  const { name, host } = business;
  const pageTitle = snapshot.title ?? snapshot.h1 ?? name;
  const hero = snapshot.h1 ?? snapshot.title ?? `${name}'s homepage`;
  const description = snapshot.description ?? "No meta description was visible in the homepage HTML we read.";
  const primaryCta = snapshot.ctas[0] ?? "No clear primary CTA found";
  const ctaLine = snapshot.ctas.length > 0 ? snapshot.ctas.join(", ") : "no obvious action buttons or links";
  const keywordLine = snapshot.keywords.length > 0 ? snapshot.keywords.join(", ") : `${name.toLowerCase()}, ${host}`;
  return {
    business,
    siteRead: snapshot,
    title: `${name}'s first-week growth teardown`,
    subtitle: `Read ${snapshot.sourceUrl} and built a launch plan from the page copy we found.`,
    sections: [
      {
        id: "snapshot",
        kind: "insight",
        heading: "What the homepage is saying right now",
        body:
          `I read ${host} and found this lead message: "${hero}". The browser title is "${pageTitle}". ` +
          `That gives us a real starting point: the page is already pointing at ${keywordLine}, but the first ` +
          `screen needs to make the buyer, outcome, and next step unmistakable before any paid traffic lands.`,
      },
      {
        id: "quick-wins",
        kind: "action",
        heading: "Three quick wins, in priority order",
        body:
          `1. Tighten the search snippet. Current description: "${description}" Use it to say who ${name} is for, ` +
          `the concrete outcome, and why a buyer should click now.\n` +
          `2. Make one action dominant. I found CTA language around: ${ctaLine}. Pick the strongest one and repeat it ` +
          `in the hero, pricing/signup area, and final section.\n` +
          `3. Turn the page's strongest terms (${keywordLine}) into proof: add one quantified result, one customer quote, ` +
          `and one comparison against the old way buyers solve this today.`,
      },
      {
        id: "headline",
        kind: "draft",
        heading: "A homepage headline you can paste in today",
        body:
          `Headline: "${hero}"\n` +
          `Sharper version: "${name} helps [specific buyer] get [measurable outcome] without [old painful workflow]."\n` +
          `Subhead: "${description}"\n` +
          `Add a proof line directly under the CTA: "Trusted for ${keywordLine} workflows" only if those claims are true.`,
      },
      {
        id: "calendar",
        kind: "action",
        heading: "Your launch-week content calendar",
        body:
          `Mon — Explain the problem behind "${hero}" in founder language.\n` +
          `Tue — Record a 45-second walkthrough ending on "${primaryCta}".\n` +
          `Wed — Publish a before/after post around ${snapshot.keywords[0] ?? name}.\n` +
          `Thu — Compare ${name} with the manual workaround buyers use today.\n` +
          `Fri — Turn the best comment or reply into a short FAQ and link back to ${host}.`,
      },
      {
        id: "outreach",
        kind: "draft",
        heading: "A cold-outreach email that doesn't read like spam",
        body:
          `Subject: a quick idea for [their company]\n\n` +
          `Hi [name] — I was reading ${host}. The page leads with "${hero}", and the strongest CTA I found was ` +
          `"${primaryCta}". I had one growth idea: turn that message into a short proof-led landing section and a ` +
          `three-post launch sequence around ${keywordLine}. Worth a 15-minute look?`,
      },
      {
        id: "next",
        kind: "insight",
        heading: "What happens when you sign in",
        body:
          `This was built from the public HTML we could read from ${snapshot.sourceUrl}. When you sign in, the team ` +
          `keeps working from real sources: Scout reads, Quill drafts, Echo adapts it for social, and Bid plans paid ` +
          `tests. You approve anything before it leaves the building; send/spend behavior stays gated.`,
      },
    ],
  };
}

/** A single streamable frame: the header, one section, or the terminal marker. */
export type DeliverableFrame =
  | { event: "start"; data: { business: DeliverableBusiness; title: string; subtitle: string; sectionCount: number } }
  | { event: "section"; data: DeliverableSection & { index: number } }
  | { event: "done"; data: { sectionCount: number } };

/** Lay a plan out as an ordered list of frames (header → each section → done). Pure; used by the route. */
export function planToFrames(plan: DeliverablePlan): DeliverableFrame[] {
  const frames: DeliverableFrame[] = [
    {
      event: "start",
      data: {
        business: plan.business,
        title: plan.title,
        subtitle: plan.subtitle,
        sectionCount: plan.sections.length,
      },
    },
  ];
  plan.sections.forEach((section, index) => {
    frames.push({ event: "section", data: { ...section, index } });
  });
  frames.push({ event: "done", data: { sectionCount: plan.sections.length } });
  return frames;
}
