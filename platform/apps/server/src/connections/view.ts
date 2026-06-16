/**
 * Pure decision logic for the connections surface (#258). No IO — the route supplies the descriptors,
 * which connections are already connected, and whether the caller is the owner/admin workspace.
 *
 *  - {@link decideConnectionView} builds what Settings renders: customer connectors always; the internal
 *    GitHub paste connector ONLY for the owner workspace (a customer must never see a repo/token field).
 *  - {@link decideInternalConnect} validates an internal paste connect. It refuses a non-owner, refuses an
 *    OAuth (customer) connector outright (paste is internal-only), and requires an `owner/repo` + a token.
 */

import type { ServiceKind } from "../onboarding/types.js";
import type { ConnectionAudience, ConnectionAuthMethod, ConnectionDescriptor, ConnectionStatus } from "./registry.js";

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
  connected: boolean;
}

export function decideConnectionView(opts: {
  descriptors: readonly ConnectionDescriptor[];
  connectedIds: ReadonlySet<string>;
  isOwner: boolean;
}): ConnectionView[] {
  return opts.descriptors
    .filter((d) => d.audience === "customer" || opts.isOwner) // internal connectors are owner-only
    .map((d) => ({
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
      connected: opts.connectedIds.has(d.id),
    }));
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
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return { ok: false, reason: "repo must be owner/repo" };
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
