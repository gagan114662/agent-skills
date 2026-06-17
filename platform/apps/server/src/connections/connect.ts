/**
 * The pure connect-once FLOW decisions (#258 Stage 2, ADR-0258). No IO — the route/service supply the caps,
 * the descriptor, and whether a live provider is wired; these decide what happens next.
 *
 *  - {@link decideConnectStart} is the front door: it returns `coming_soon` (the Stage 1 honest stub) unless
 *    the live flow is in scope for the workspace AND a live provider is wired AND the connector is an OAuth
 *    one — only then does it return `needs_approval`, which tells the service to park a PENDING #13 request
 *    (the live connect ALWAYS pauses for an explicit owner approval; there is no autonomous-connect path).
 *  - {@link mapExchangeToSeal} maps a provider exchange to a vault seal, and is the never-seal-a-blank rule:
 *    an exchange that minted nothing usable (no secrets) yields `{ seal: false }`, so the seam can never mark
 *    a connection connected without a real credential behind it.
 */
import type { ConnectionDescriptor } from "./registry.js";
import type { ConnectOnceCaps } from "./caps.js";
import { isConnectOnceLiveInScope } from "./caps.js";
import type { ConnectExchangeResult } from "./provider.js";

export type ConnectStartOutcome =
  /** The live flow is offered + in scope: park a PENDING `connection.connect_account` #13 request. */
  | { outcome: "needs_approval" }
  /** Not offered yet (flag off / not the owner workspace / no live provider / not an OAuth connector). */
  | { outcome: "coming_soon"; reason: string };

/**
 * Decide what `POST /me/connections/:id/oauth/start` does. Fail-closed: anything other than an in-scope,
 * live, OAuth connector degrades to the honest `coming_soon` (today's behavior). Pure + total.
 */
export function decideConnectStart(input: {
  descriptor: ConnectionDescriptor | undefined;
  caps: ConnectOnceCaps;
  workspaceId: string;
  /** Whether a live provider is wired for this connector (the route reads `provider.live`). */
  liveProviderConfigured: boolean;
}): ConnectStartOutcome {
  const d = input.descriptor;
  if (!d || d.auth !== "oauth") {
    return { outcome: "coming_soon", reason: "not an OAuth connection" };
  }
  if (!isConnectOnceLiveInScope(input.caps, input.workspaceId)) {
    return {
      outcome: "coming_soon",
      reason: `Connecting ${d.label} is rolling out — it's coming soon.`,
    };
  }
  if (!input.liveProviderConfigured) {
    return {
      outcome: "coming_soon",
      reason: `Connecting ${d.label} is rolling out — it's coming soon.`,
    };
  }
  return { outcome: "needs_approval" };
}

export type SealDecision =
  | { seal: true; serviceKey: string; serviceKind: ConnectionDescriptor["kind"]; scopes: string[]; secrets: Record<string, string> }
  | { seal: false; reason: string };

/**
 * Map a provider exchange to a vault seal for `descriptor`. Never-seal-a-blank: an exchange with no secrets
 * (the dry-run/failed-mint case) yields `{ seal: false }` — so a connection is marked connected ONLY when a
 * real credential is sealed behind it. The granted `capabilities` become the vault `scopes` downstream
 * agents read; they default to the descriptor's declared capabilities when the provider returned none. Pure.
 */
export function mapExchangeToSeal(input: {
  descriptor: ConnectionDescriptor;
  exchange: ConnectExchangeResult;
}): SealDecision {
  const { secrets } = input.exchange;
  const keys = Object.keys(secrets);
  if (keys.length === 0 || keys.some((k) => (secrets[k] ?? "").trim().length === 0)) {
    return { seal: false, reason: "exchange produced no usable credential" };
  }
  const scopes =
    input.exchange.capabilities.length > 0
      ? [...input.exchange.capabilities]
      : [...input.descriptor.capabilities];
  return {
    seal: true,
    serviceKey: input.descriptor.id,
    serviceKind: input.descriptor.kind,
    scopes,
    secrets,
  };
}
