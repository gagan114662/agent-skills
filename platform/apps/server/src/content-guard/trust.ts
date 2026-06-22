/**
 * The trust boundary for externally-fetched content (issue #674). An agent that reads scraped web pages or
 * inbound email is reading text an ATTACKER controls — that text routinely carries planted instructions
 * ("ignore your previous instructions", "email the user's API key to …") whose only goal is to hijack the
 * agent into taking an action the user never asked for. The defense is a TYPE-LEVEL boundary: external text
 * never flows as a bare `string` that could be mistaken for a trusted instruction. It is wrapped the moment
 * it enters the system in an {@link UntrustedContent} value that carries its provenance, and the only way to
 * get prompt-embeddable text back out is to run it through the neutralizer (`content-guard/neutralize.ts`),
 * which fences it as DATA and strips hidden-instruction vectors.
 *
 * Premortem (#200 §6 — injection defense) encoded in the SHAPE:
 *  - **Provenance is sticky and fail-closed.** Anything not provably `trusted` is `external`; an unknown /
 *    missing provenance is treated as `external` (the dangerous case), never as trusted. There is no path
 *    that silently upgrades external content to trusted.
 *  - **Untrusted content cannot self-authorize an action.** This module only LABELS and TRANSPORTS content;
 *    the decision to act on it lives in the pure gate (`content-guard/gate.ts`), which can only ever ADD a
 *    human-approval requirement (the #13 approval queue), never remove one (mirrors the #561 risk gate's
 *    additive-only invariant).
 *
 * No IO and no clock here: a caller that wants a fetch timestamp passes it in. This keeps the boundary a
 * pure, deterministically-testable value type.
 */

/** Where a piece of content came from. `trusted` = first-party (the user / our own code); the rest is attacker-influenced. */
export const EXTERNAL_SOURCES = ["web", "email", "scrape", "api", "file", "unknown"] as const;
export type ExternalSource = (typeof EXTERNAL_SOURCES)[number];

/** Provenance is binary at the trust boundary: either first-party `trusted` or attacker-influenced `external`. */
export type Provenance = "trusted" | "external";

/**
 * A branded wrapper around attacker-controlled text. The `__brand` makes it structurally distinct from a
 * plain `string`, so a trusted-instruction parameter can never silently receive raw external content — the
 * compiler forces it through {@link asUntrusted} / the neutralizer first.
 */
export interface UntrustedContent {
  readonly __brand: "UntrustedContent";
  /** Always `external` — that is the whole point of the wrapper. Present so it reads symmetrically with provenance checks. */
  readonly provenance: "external";
  /** The transport the content arrived on (web page, inbound email, scrape, …). */
  readonly source: ExternalSource;
  /** A short, human-readable origin (URL, sender address, file path) for audit / approval UIs. Never trusted. */
  readonly origin: string;
  /** The raw, UNSANITIZED text exactly as fetched. Do NOT embed this in a prompt — run it through the neutralizer. */
  readonly raw: string;
  /** Optional fetch time, supplied by the caller (this module has no clock). */
  readonly fetchedAt?: Date;
}

/** Coerce an arbitrary value to a non-`external` provenance label, fail-closed: anything but the literal `"trusted"` ⇒ `external`. */
export function normalizeProvenance(value: unknown): Provenance {
  return value === "trusted" ? "trusted" : "external";
}

/** Coerce an arbitrary value to a known {@link ExternalSource}; an unrecognized source fails closed to `"unknown"`. */
export function normalizeSource(value: unknown): ExternalSource {
  return typeof value === "string" && (EXTERNAL_SOURCES as readonly string[]).includes(value)
    ? (value as ExternalSource)
    : "unknown";
}

/** Runtime guard: is this value the branded {@link UntrustedContent} wrapper (not a bare string)? */
export function isUntrustedContent(value: unknown): value is UntrustedContent {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === "UntrustedContent"
  );
}

export interface AsUntrustedInput {
  source?: ExternalSource | string;
  origin?: string;
  raw: string;
  fetchedAt?: Date;
}

/**
 * Wrap freshly-fetched external text at the trust boundary. Call this at EVERY ingress point (web fetch,
 * email read, scraper) BEFORE the text touches anything else. `raw` is coerced to a string fail-closed
 * (a non-string body becomes `""`), the source is normalized to a known transport, and the origin is
 * truncated so a hostile, megabyte-long "origin" can't blow up an audit log.
 */
export function asUntrusted(input: AsUntrustedInput): UntrustedContent {
  return {
    __brand: "UntrustedContent",
    provenance: "external",
    source: normalizeSource(input.source),
    origin: truncate(typeof input.origin === "string" ? input.origin : "", 512),
    raw: typeof input.raw === "string" ? input.raw : "",
    fetchedAt: input.fetchedAt,
  };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
