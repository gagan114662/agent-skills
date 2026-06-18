/**
 * The PURE capability-token mint decision (#336, ADR-0336). No IO — the service supplies the caps, the
 * capabilities the connection actually granted, and the request; this decides whether (and how narrowly) a
 * token may be minted. Every safety property of the model is a structural check here:
 *
 *  - **Least-privilege / injection defense (premortem §6):** a token may only authorize a capability the
 *    CONNECTION GRANT actually contains. The grant is the sealed #258 vault scopes — never a provider/MCP
 *    response — so a poisoned read can never widen what a token can do. A requested capability outside the
 *    grant is refused outright (`scope_denied`), not silently dropped.
 *  - **Irreversible actions stay pre-committed (premortem §4):** a `write` (send/post/spend) token is
 *    refused (`needs_approval`) unless the caller supplies an approved #13 `approvalRequestId`. The mint can
 *    never be the gate for an outward mutation — the owner's pre-commitment must already exist.
 *  - **Short-lived:** the TTL is clamped into the workspace's configured bounds; a request can shorten but
 *    never lengthen past the max.
 *  - **Fail-closed:** out of scope (flag off / not the owner workspace) ⇒ `disabled`, mints nothing.
 */
import {
  isCapabilityMintLiveInScope,
  type CapabilityTokenCaps,
} from "./token-caps.js";
import { isTokenVerb, type TokenVerb } from "./token.js";

/** A raw, untrusted mint request (from an agent action). All fields are validated before anything is minted. */
export interface TokenMintRequest {
  connectionId: string;
  /** The single capability the action needs (e.g. `search_console`). Must be within the connection grant. */
  capability: string;
  verb: TokenVerb;
  /** The agent the grant is delegated to (…→agent→service). */
  agentId: string;
  /** The member/user who holds the connection grant (the delegation root, user→…). */
  memberId: string;
  /** Optional requested TTL (seconds); clamped to the workspace bounds. */
  requestedTtlSeconds?: number;
  /** The approved #13 request that pre-commits a `write`; ignored for a `read`. */
  approvalRequestId?: string | null;
}

/** The validated, least-privilege grant a token is minted from. */
export interface TokenGrant {
  connectionId: string;
  capability: string;
  verb: TokenVerb;
  agentId: string;
  memberId: string;
  /** The clamped, short-lived TTL the token's `exp` is derived from. */
  ttlSeconds: number;
  /** The #13 pre-commitment carried into the token for a `write`; null for a `read`. */
  approvalRequestId: string | null;
}

/** Why a mint was refused — each maps to a distinct, honest caller outcome. */
export type TokenMintRefusal =
  | "disabled" // the live mint is off / out of scope for this workspace (default OFF, owner-first)
  | "invalid" // the request is missing a required field or carries an unknown verb
  | "not_connected" // the connection grants nothing (not connected / revoked)
  | "scope_denied" // the requested capability is outside the connection grant (injection defense)
  | "needs_approval"; // a write token requires a prior owner #13 approval (irreversible pre-commit)

export type TokenMintDecision =
  | { mint: true; grant: TokenGrant }
  | { mint: false; status: TokenMintRefusal; reason: string };

/** Strip control characters + clamp — a refusal reason may echo a requested capability (untrusted input). */
function sanitizeLabel(value: string, max = 80): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, max);
}

/** Clamp a requested TTL into [floor-respecting default, maxTtlSeconds]; omitted/non-finite/≤0 ⇒ the default. */
export function clampTtl(requested: number | undefined, caps: CapabilityTokenCaps): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return caps.defaultTtlSeconds;
  }
  return Math.min(Math.floor(requested), caps.maxTtlSeconds);
}

/**
 * Decide whether `request` may mint a capability token. Pure + total + fail-closed. The order matters: scope
 * is checked before the write-approval gate so a `scope_denied` is always reported as such (never masked by a
 * missing approval), and the live-mint flag is checked first so a disabled workspace reveals nothing about
 * grants.
 */
export function decideTokenMint(input: {
  caps: CapabilityTokenCaps;
  workspaceId: string;
  /** The capabilities the connection actually granted (the sealed #258 vault scopes) — the SOLE authority. */
  connectionGranted: ReadonlySet<string>;
  request: TokenMintRequest;
}): TokenMintDecision {
  const { caps, workspaceId, connectionGranted, request } = input;

  // 1. Fail-closed: the live mint must be enabled + in scope for this workspace (default OFF, owner-first).
  if (!isCapabilityMintLiveInScope(caps, workspaceId)) {
    return {
      mint: false,
      status: "disabled",
      reason: "capability-token minting is disabled for this workspace (default OFF — owner enables it)",
    };
  }

  // 2. Basic shape — never mint off a malformed request.
  if (
    !request.connectionId ||
    !request.capability ||
    !request.agentId ||
    !request.memberId ||
    !isTokenVerb(request.verb)
  ) {
    return { mint: false, status: "invalid", reason: "missing connection, capability, agent, member, or verb" };
  }

  // 3. Least-privilege + injection defense: the capability MUST come from the connection grant (the sealed
  //    #258 scopes), never from any provider/MCP response. An empty grant ⇒ not connected; an out-of-grant
  //    capability ⇒ refused (the token can never authorize more than the user actually consented to).
  if (connectionGranted.size === 0) {
    return {
      mint: false,
      status: "not_connected",
      reason: "connect the account before minting a capability token",
    };
  }
  if (!connectionGranted.has(request.capability)) {
    return {
      mint: false,
      status: "scope_denied",
      reason: `the connection does not grant "${sanitizeLabel(request.capability)}"`,
    };
  }

  // 4. Irreversible pre-commitment: a write (send/post/spend) is outward + not cheaply reversible, so it can
  //    only be minted when an owner #13 approval already exists. The mint is never the gate (premortem §4).
  const approvalRequestId =
    typeof request.approvalRequestId === "string" && request.approvalRequestId.trim().length > 0
      ? request.approvalRequestId.trim()
      : null;
  if (request.verb === "write" && approvalRequestId === null) {
    return {
      mint: false,
      status: "needs_approval",
      reason:
        "a write (send/post/spend) token requires a prior owner #13 approval — irreversible actions are pre-committed, never autonomous",
    };
  }

  return {
    mint: true,
    grant: {
      connectionId: request.connectionId,
      capability: request.capability,
      verb: request.verb,
      agentId: request.agentId,
      memberId: request.memberId,
      ttlSeconds: clampTtl(request.requestedTtlSeconds, caps),
      // A read carries no pre-commitment; a write carries the approval that authorized it.
      approvalRequestId: request.verb === "write" ? approvalRequestId : null,
    },
  };
}
