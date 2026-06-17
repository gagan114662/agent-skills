/**
 * Connected-capability resolution (#258 Stage 2, ADR-0258). The read side of the connect-once seam: given
 * which connections a workspace has connected, which real-world CAPABILITIES are now unlocked. This is what
 * the per-department follow-ups gate their work on — Scout asks "is `search_console` connected?" before it
 * verifies the domain / submits the sitemap (#265); Echo asks "is `post_social` connected?" before it posts
 * (#269); Bid asks "is `ads` connected?" (#272). Pure — the route/service supplies the connected ids.
 */
import type { ConnectionDescriptor } from "./registry.js";

/**
 * The set of capability ids unlocked by the workspace's connected connections. A connector contributes its
 * declared `capabilities` only when it is actually connected, so an unconnected workspace resolves to the
 * empty set (every downstream agent stays gated until the consent exists). Pure + total.
 */
export function decideConnectedCapabilities(input: {
  descriptors: readonly ConnectionDescriptor[];
  connectedIds: ReadonlySet<string>;
}): Set<string> {
  const caps = new Set<string>();
  for (const d of input.descriptors) {
    if (!input.connectedIds.has(d.id)) continue;
    for (const c of d.capabilities) caps.add(c);
  }
  return caps;
}

/**
 * True iff `capability` is unlocked for the workspace given its connected connections. The one-line gate a
 * department agent calls before acting (e.g. `hasConnectedCapability({..., capability: "search_console"})`).
 */
export function hasConnectedCapability(input: {
  descriptors: readonly ConnectionDescriptor[];
  connectedIds: ReadonlySet<string>;
  capability: string;
}): boolean {
  return decideConnectedCapabilities(input).has(input.capability);
}
