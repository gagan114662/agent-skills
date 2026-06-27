/**
 * Pure decision logic for the connections surface (#258). No IO — the route supplies the descriptors,
 * which connections are already connected, and whether the caller is the owner/admin workspace.
 *
 *  - {@link decideConnectionView} builds what Settings renders: customer connectors always; the internal
 *    GitHub paste connector ONLY for the owner workspace (a customer must never see a repo/token field).
 *  - {@link decideInternalConnect} validates an internal paste connect. It refuses a non-owner, refuses an
 *    OAuth (customer) connector outright (paste is internal-only), and requires an `owner/repo` + a token.
 *  - {@link decideOneClickConnect} validates a one-click customer consent (e.g. turning on outbound email,
 *    #529): it accepts only a customer connector whose auth is `one_click` and whose live flow is wired
 *    (`available`). No secret is sealed — the consent is recorded, but provider proof is still required
 *    before the connection is treated as live.
 *  - {@link decideWaitlist} validates a "notify me" request for a connector whose live flow isn't wired yet
 *    (`coming_soon`), so a not-yet-available connector offers a next step instead of a dead stop.
 */

import type { ServiceKind } from "../onboarding/types.js";
import type { ConnectionAudience, ConnectionAuthMethod, ConnectionDescriptor, ConnectionStatus } from "./registry.js";

export interface ConnectionProofInput {
  connected: boolean;
  envKeys: readonly string[];
  fingerprint: string;
  connectedAtMs: number;
}

export type ConnectionConsentStatus = "none" | "recorded";
export type ConnectionProviderStatus = "unproven" | "healthy";

/** A connection as rendered in Settings — descriptor metadata + whether it's connected. Never a secret. */
export interface ConnectionView {
  id: string;
  label: string;
  summary: string;
  provider: string;
  kind: ServiceKind;
  audience: ConnectionAudience;
  auth: ConnectionAuthMethod;
  status: ConnectionStatus;
  capabilities: string[];
  oauthScopes: string[];
  consentStatus: ConnectionConsentStatus;
  providerStatus: ConnectionProviderStatus;
  lastProofAt: number | null;
  lastProofReceipt: string | null;
  failureReason: string | null;
  configIssue: ConnectionDescriptor["configIssue"] | null;
  /** True only when provider proof has passed; consent alone is not connected (#1284). */
  connected: boolean;
}

function proofFor(d: ConnectionDescriptor, proof: ConnectionProofInput | undefined): {
  consentStatus: ConnectionConsentStatus;
  providerStatus: ConnectionProviderStatus;
  lastProofAt: number | null;
  lastProofReceipt: string | null;
  failureReason: string | null;
  connected: boolean;
} {
  if (!proof?.connected) {
    return {
      consentStatus: "none",
      providerStatus: "unproven",
      lastProofAt: null,
      lastProofReceipt: null,
      failureReason: null,
      connected: false,
    };
  }
  const hasProviderProof = proof.envKeys.length > 0;
  if (hasProviderProof) {
    return {
      consentStatus: "recorded",
      providerStatus: "healthy",
      lastProofAt: proof.connectedAtMs,
      lastProofReceipt: `vault:${proof.fingerprint.slice(0, 12)}`,
      failureReason: null,
      connected: true,
    };
  }
  return {
    consentStatus: "recorded",
    providerStatus: "unproven",
    lastProofAt: null,
    lastProofReceipt: null,
    failureReason:
      d.auth === "one_click"
        ? "Consent is recorded, but no provider health check has passed yet."
        : "Provider proof is missing.",
    connected: false,
  };
}

export function decideConnectionView(opts: {
  descriptors: readonly ConnectionDescriptor[];
  proofs: ReadonlyMap<string, ConnectionProofInput>;
  isOwner: boolean;
}): ConnectionView[] {
  return opts.descriptors
    .filter((d) => d.audience === "customer" || opts.isOwner) // internal connectors are owner-only
    .map((d) => {
      const proof = proofFor(d, opts.proofs.get(d.id));
      return {
        id: d.id,
        label: d.label,
        summary: d.summary,
        provider: d.provider,
        kind: d.kind,
        audience: d.audience,
        auth: d.auth,
        status: d.status,
        capabilities: d.capabilities,
        oauthScopes: d.oauthScopes,
        configIssue: d.configIssue ?? null,
        ...proof,
      };
    });
}

/**
 * True iff `slug` is a safe `owner/repo` that is then interpolated directly into a GitHub REST API URL.
 * Restricted to GitHub's naming conventions (owner: alphanumeric + hyphen; repo: adds dot/underscore) and
 * explicitly forbids `.`/`..` as the repo name — so a path-traversal segment can never reach the API path.
 */
export function isValidRepoSlug(slug: string): boolean {
  if (!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(slug)) return false;
  const repo = slug.split("/")[1];
  return repo !== "." && repo !== "..";
}

export type InternalConnectDecision =
  | { ok: true; serviceKey: string; serviceKind: ServiceKind; scopes: string[]; secrets: Record<string, string> }
  | { ok: false; reason: string };

export function decideInternalConnect(opts: {
  descriptor: ConnectionDescriptor | undefined;
  isOwner: boolean;
  repo?: string;
  token?: string;
  baseBranch?: string;
}): InternalConnectDecision {
  const d = opts.descriptor;
  if (!d) return { ok: false, reason: "unknown connection" };
  if (d.auth !== "paste_internal") {
    return { ok: false, reason: "this connection uses OAuth — paste is not supported" };
  }
  if (!opts.isOwner) return { ok: false, reason: "internal connection — admin only" };
  const repo = opts.repo?.trim() ?? "";
  const token = opts.token?.trim() ?? "";
  if (!token) return { ok: false, reason: "a GitHub token is required" };
  if (!isValidRepoSlug(repo)) return { ok: false, reason: "repo must be owner/repo" };
  const baseBranch = opts.baseBranch?.trim() || "main";
  return {
    ok: true,
    serviceKey: d.id,
    serviceKind: d.kind,
    scopes: d.capabilities,
    secrets: {
      REALWORLD_GITHUB_TOKEN: token,
      REALWORLD_SITE_REPO: repo,
      REALWORLD_SITE_BASE_BRANCH: baseBranch,
    },
  };
}

export type OneClickConnectDecision =
  | { ok: true; serviceKey: string; serviceKind: ServiceKind; scopes: string[] }
  | { ok: false; reason: string };

/**
 * Validate a one-click customer consent (#529, e.g. turning on outbound email). No secret changes hands, so
 * this only checks the connector is a customer one-click connector whose live flow is wired. Provider proof
 * is a separate health/readback step; consent alone must not unlock live capabilities (#1284). A
 * `coming_soon` connector is refused here (use {@link decideWaitlist} instead).
 */
export function decideOneClickConnect(opts: {
  descriptor: ConnectionDescriptor | undefined;
}): OneClickConnectDecision {
  const d = opts.descriptor;
  if (!d) return { ok: false, reason: "unknown connection" };
  if (d.audience !== "customer") return { ok: false, reason: "not a customer connection" };
  if (d.auth !== "one_click") return { ok: false, reason: "this connection isn't a one-click connect" };
  if (d.status !== "available") return { ok: false, reason: "this connection isn't available yet" };
  return { ok: true, serviceKey: d.id, serviceKind: d.kind, scopes: d.capabilities };
}

export type WaitlistDecision =
  | { ok: true; connectionId: string; provider: string }
  | { ok: false; reason: string };

/**
 * Validate a "notify me when it's ready" request for a connector whose live flow isn't wired yet. Only a
 * customer connector that is genuinely `coming_soon` qualifies — an already-available connector should be
 * connected, not waitlisted, and an internal connector is never customer-facing.
 */
export function decideWaitlist(opts: {
  descriptor: ConnectionDescriptor | undefined;
}): WaitlistDecision {
  const d = opts.descriptor;
  if (!d) return { ok: false, reason: "unknown connection" };
  if (d.audience !== "customer") return { ok: false, reason: "not a customer connection" };
  if (d.status !== "coming_soon") return { ok: false, reason: "this connection is already available" };
  return { ok: true, connectionId: d.id, provider: d.provider };
}
