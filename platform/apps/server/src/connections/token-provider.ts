/**
 * The capability-token VERIFY seam (#336, ADR-0336) — production-grounded verification (premortem §3). A
 * minted token is only useful if it actually works against the provider; this seam reads BACK from the real
 * provider/MCP API to prove that, instead of assuming success. A live, fetch-backed provider slots in behind
 * the #258 vault credential LATER without changing the service.
 *
 * The DEFAULT is {@link DryRunCapabilityTokenProvider}: it makes NO network call and reports `verified:false`.
 * That is deliberate and honest — with no live provider there is no confirmed read-back, so a minted token is
 * truthfully labeled "unverified" rather than claiming a fabricated success (premortem §3). No live verifier
 * is wired in this slice, so every deployment resolves to the dry-run provider.
 *
 * Injection defense (premortem §6) is STRUCTURAL: a {@link TokenVerification} can only report `verified`, a
 * sanitized `detail`, and an opaque `externalRef`. It has NO field that could add or widen a capability — the
 * provider's response is untrusted DATA that can confirm/deny a token, never expand what it authorizes.
 */
import type { TokenVerb } from "./token.js";

/** Max length kept for a provider-returned detail / external reference — untrusted, so it is bounded. */
const MAX_DETAIL_LEN = 300;
const MAX_REF_LEN = 200;

/** The verdict a verify read-back produces — filled ONLY from a provider response, never fabricated. */
export interface TokenVerification {
  /** True iff the provider's real API confirmed the token works for the capability. Never assumed. */
  verified: boolean;
  /** An opaque provider reference proving the read-back came from outside (e.g. a request id); null when none. */
  externalRef: string | null;
  /** A sanitized, human-readable detail (untrusted DATA — never instructions, never widens scope). */
  detail: string;
}

export interface VerifyTokenInput {
  workspaceId: string;
  connectionId: string;
  capability: string;
  verb: TokenVerb;
}

export interface CapabilityTokenProvider {
  /** Whether this provider can perform a real read-back. The service records the result as `verified`. */
  readonly live: boolean;
  /**
   * Read back from the provider's REAL API to prove the just-minted token works for `capability`. The result
   * is untrusted DATA: it may set `verified` true/false and carry a sanitized `detail`/`externalRef`, but it
   * can NEVER add or widen a capability (the return type has no scope field — premortem §6).
   */
  verify(input: VerifyTokenInput): Promise<TokenVerification>;
}

/** Strip control characters and clamp — a provider string is untrusted DATA, never an instruction. */
export function sanitizeProviderText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, max);
}

/**
 * Normalize an untrusted provider response into a {@link TokenVerification}. Re-deriving from ONLY
 * `verified`/`externalRef`/`detail` is the structural injection screen — any extra fields a malicious
 * provider returns are dropped, and `verified` is coerced to a strict boolean so a truthy-but-non-boolean
 * value can never read as confirmed.
 */
export function normalizeVerification(raw: {
  verified?: unknown;
  externalRef?: unknown;
  detail?: unknown;
}): TokenVerification {
  return {
    verified: raw.verified === true,
    externalRef:
      typeof raw.externalRef === "string" && raw.externalRef.trim().length > 0
        ? sanitizeProviderText(raw.externalRef, MAX_REF_LEN)
        : null,
    detail: sanitizeProviderText(raw.detail, MAX_DETAIL_LEN),
  };
}

/** The default provider: no network call, nothing confirmed — a minted token is honestly "unverified". */
export class DryRunCapabilityTokenProvider implements CapabilityTokenProvider {
  readonly live = false;
  async verify(): Promise<TokenVerification> {
    return {
      verified: false,
      externalRef: null,
      detail: "dryrun: no live provider connected — token minted but unverified",
    };
  }
}

/**
 * A TEST/DEMO double. Returns a clearly synthetic, confirmed read-back so the verify path is exercisable
 * end-to-end WITHOUT a real provider account or any network call. Never selected by production wiring.
 */
export class MockCapabilityTokenProvider implements CapabilityTokenProvider {
  readonly live = true;
  constructor(
    private readonly opts: { verified?: boolean; externalRef?: string; detail?: string } = {},
  ) {}
  async verify(input: VerifyTokenInput): Promise<TokenVerification> {
    return normalizeVerification({
      verified: this.opts.verified ?? true,
      externalRef: this.opts.externalRef ?? `mock-ref:${input.connectionId}:${input.capability}`,
      detail: this.opts.detail ?? "mock read-back",
    });
  }
}
