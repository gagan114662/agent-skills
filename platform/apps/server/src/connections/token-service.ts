/**
 * The capability-token SERVICE (#336, ADR-0336) — the IO orchestrator that mints a per-action token on top
 * of the #258 connect-once seam. It owns no new authority: the pure {@link decideTokenMint} makes the
 * least-privilege decision, the connection grant comes from the sealed #258 vault scopes, and every side
 * effect is one injected seam (so the service runs against fakes in unit tests and real repos in `default.ts`,
 * mirroring `search-console/service.ts`).
 *
 * The shape encodes the model:
 *  - an agent calls {@link CapabilityTokenService.mintForAction} per action — it never holds a standing secret;
 *  - the raw provider secret is never read here (it stays sealed in the #192 vault) — the token is a signed,
 *    short-lived, delegated claim, not the credential;
 *  - production-grounded verification (premortem §3): after minting, the provider's real API is read back to
 *    prove the token works — `verified` is recorded from that read-back, NEVER assumed;
 *  - traceability: every mint emits a user→agent→service record into the #13 approval-queue audit trail;
 *  - idempotency: a re-mint with the same `idempotencyKey` returns the SAME unexpired token (no duplicate
 *    mint, no duplicate audit row).
 */
import { randomUUID } from "node:crypto";
import {
  isCapabilityTokenExpired,
  signCapabilityToken,
  verifyCapabilityToken,
  CAPABILITY_TOKEN_DEFAULT_KEY_ID,
  type CapabilityTokenClaims,
  type TokenVerb,
} from "./token.js";
import { decideTokenMint, type TokenMintRefusal } from "./token-mint.js";
import type { CapabilityTokenCaps } from "./token-caps.js";
import type { CapabilityTokenProvider, TokenVerification } from "./token-provider.js";

/** A previously-minted token, kept (until it expires) so a repeat idempotency key returns the same token. */
export interface StoredMint {
  token: string;
  claims: CapabilityTokenClaims;
  verification: TokenVerification;
}

/** The idempotency store seam. The production default is an in-memory TTL map; tests inject a fake. */
export interface MintRecordStore {
  get(workspaceId: string, key: string): Promise<StoredMint | null>;
  put(workspaceId: string, key: string, value: StoredMint): Promise<void>;
}

/** The user→agent→service audit record written into the #13 approval-queue trail (recorded-only). */
export interface MintAuditInput {
  workspaceId: string;
  memberId: string;
  agentId: string;
  connectionId: string;
  capability: string;
  verb: TokenVerb;
  /** The #13 pre-commitment a write rode in on; null for a read. */
  approvalRequestId: string | null;
  jti: string;
  expEpochMs: number;
  verified: boolean;
}

export interface CapabilityTokenDeps {
  caps(workspaceId: string): CapabilityTokenCaps;
  /**
   * The capabilities the connection actually granted for this workspace — the sealed #258 vault scopes. This
   * is the SOLE authority a token can be minted against (premortem §6: never a provider/MCP response).
   */
  connectionGrant(workspaceId: string, connectionId: string): Promise<ReadonlySet<string>>;
  /** The verify provider for a connection (dry-run by default — see token-provider.ts). */
  provider(connectionId: string): CapabilityTokenProvider;
  /** The HMAC secret the token is signed with (read live, like `loadStateSecret`). */
  signingSecret(): string;
  /** Non-secret signing key id carried by new tokens and logged for rotation audits. */
  signingKeyId?(): string;
  /** Idempotency persistence (an in-memory TTL store in prod; a fake in tests). */
  store: MintRecordStore;
  /** Emit the delegation record into the #13 audit trail. Returns the recorded request id. */
  recordMint(input: MintAuditInput): Promise<{ id: string }>;
  now(): number;
  /** Optional logger so an audit/store hiccup is observable without throwing out of a correct mint. */
  log?: { warn?: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

export interface MintForActionInput {
  workspaceId: string;
  connectionId: string;
  capability: string;
  verb: TokenVerb;
  /** The agent the grant is delegated to. */
  agentId: string;
  /** The member/user who holds the connection grant (the delegation root). */
  memberId: string;
  requestedTtlSeconds?: number;
  /** Required for a `write`: the approved #13 request that pre-commits the irreversible action. */
  approvalRequestId?: string | null;
  /** Idempotency key — a repeat with the same key returns the same unexpired token. */
  idempotencyKey?: string;
}

export type MintForActionResult =
  | {
      status: "minted";
      token: string;
      claims: CapabilityTokenClaims;
      verification: TokenVerification;
      /** True iff this returned a prior token for a repeated idempotency key (no new mint). */
      reused: boolean;
      /** The #13 audit record id for this mint, or null when reused / the audit write was swallowed. */
      auditRequestId: string | null;
    }
  | { status: TokenMintRefusal; reason: string };

export class CapabilityTokenService {
  constructor(private readonly deps: CapabilityTokenDeps) {}

  /**
   * Mint a capability token for ONE action. Returns a refusal (`disabled`/`invalid`/`not_connected`/
   * `scope_denied`/`needs_approval`) or a minted token with its production-grounded verification. The token
   * is the only thing the agent gets — never the underlying secret.
   */
  async mintForAction(input: MintForActionInput): Promise<MintForActionResult> {
    const now = this.deps.now();

    // Idempotency: a live (unexpired) prior mint for the same key returns the SAME token — no second mint,
    // no second audit row. An expired record is ignored (it falls through to a fresh mint).
    const key = input.idempotencyKey?.trim();
    if (key) {
      const prior = await this.deps.store.get(input.workspaceId, key).catch(() => null);
      if (prior && !isCapabilityTokenExpired(prior.claims, now)) {
        return {
          status: "minted",
          token: prior.token,
          claims: prior.claims,
          verification: prior.verification,
          reused: true,
          auditRequestId: null,
        };
      }
    }

    const connectionGranted = await this.deps.connectionGrant(input.workspaceId, input.connectionId);
    const decision = decideTokenMint({
      caps: this.deps.caps(input.workspaceId),
      workspaceId: input.workspaceId,
      connectionGranted,
      request: {
        connectionId: input.connectionId,
        capability: input.capability,
        verb: input.verb,
        agentId: input.agentId,
        memberId: input.memberId,
        requestedTtlSeconds: input.requestedTtlSeconds,
        approvalRequestId: input.approvalRequestId,
      },
    });
    if (!decision.mint) {
      return { status: decision.status, reason: decision.reason };
    }

    const grant = decision.grant;
    const kid = this.deps.signingKeyId?.() ?? CAPABILITY_TOKEN_DEFAULT_KEY_ID;
    const claims: CapabilityTokenClaims = {
      kid,
      workspaceId: input.workspaceId,
      connectionId: grant.connectionId,
      capability: grant.capability,
      verb: grant.verb,
      delegation: { memberId: grant.memberId, agentId: grant.agentId },
      approvalRequestId: grant.approvalRequestId,
      // A repeated idempotency key keeps the jti stable; otherwise a fresh, unguessable id.
      jti: key ?? randomUUID(),
      iat: now,
      exp: now + grant.ttlSeconds * 1000,
    };
    this.deps.log?.info?.({ kid, workspaceId: input.workspaceId, connectionId: grant.connectionId }, "capability-token signed");
    const token = signCapabilityToken(claims, this.deps.signingSecret());

    // Production-grounded verification (premortem §3): prove the token works against the real API. The
    // result is recorded as-is — never assumed — and the provider can only confirm/deny, never widen scope.
    const verification = await this.deps
      .provider(grant.connectionId)
      .verify({
        workspaceId: input.workspaceId,
        connectionId: grant.connectionId,
        capability: grant.capability,
        verb: grant.verb,
      })
      .catch(
        (): TokenVerification => ({
          verified: false,
          externalRef: null,
          detail: "verification failed — token minted but unverified",
        }),
      );

    const stored: StoredMint = { token, claims, verification };
    if (key) {
      await this.deps.store.put(input.workspaceId, key, stored).catch((err) => {
        this.deps.log?.warn?.({ err }, "capability-token: failed to persist idempotency record");
      });
    }

    // Traceability: the user→agent→service delegation lands in the #13 audit trail (recorded-only, not
    // money). An audit hiccup must never throw out of an otherwise-correct mint, so it is swallowed + logged.
    const auditRequestId = await this.deps
      .recordMint({
        workspaceId: input.workspaceId,
        memberId: grant.memberId,
        agentId: grant.agentId,
        connectionId: grant.connectionId,
        capability: grant.capability,
        verb: grant.verb,
        approvalRequestId: grant.approvalRequestId,
        jti: claims.jti,
        expEpochMs: claims.exp,
        verified: verification.verified,
      })
      .then((r) => r.id)
      .catch((err) => {
        this.deps.log?.warn?.({ err }, "capability-token: failed to record mint audit entry");
        return null;
      });

    return { status: "minted", token, claims, verification, reused: false, auditRequestId };
  }

  /** Verify a presented token (signature + TTL). Returns the claims, or null when invalid/expired. */
  verifyToken(token: string): CapabilityTokenClaims | null {
    return verifyCapabilityToken(token, this.deps.signingSecret(), { now: this.deps.now() });
  }
}
