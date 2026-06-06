import type { FastifyReply } from "fastify";
import type { Identity } from "./identity.js";
import { getChannel, isChannelMember, type Channel } from "../db/repositories/channels.js";
import { getCapability, type Capability } from "../db/repositories/permissions.js";

export type { Capability };

/**
 * The RBAC ladder (issue #9): read < write < propagate. Capabilities are cumulative —
 * a higher rank implies every lower one.
 */
const RANK: Record<Capability, number> = { read: 1, write: 2, propagate: 3 };

/** True when the held capability meets or exceeds the needed one. */
export function satisfies(have: Capability, needed: Capability): boolean {
  return RANK[have] >= RANK[needed];
}

/**
 * A member's effective capability on a resource, layered on #4 membership:
 *   - non-member  → null (no access; membership is still the first gate, ADR-0004)
 *   - explicit grant present → that level (a `read` grant is a deliberate downgrade)
 *   - member, no grant → `write` (preserves #4: every channel member could post)
 */
export function effectiveCapability(
  explicit: Capability | null,
  isMember: boolean,
): Capability | null {
  if (!isMember) return null;
  return explicit ?? "write";
}

/**
 * Load a channel and assert the caller may act on it at `needed` level. The single access
 * call routes make — keeps routes thin. On failure it sends the response (404 cross-workspace
 * / not-found, 403 insufficient capability) and returns undefined.
 */
export async function requireChannelCapability(
  identity: Identity,
  channelId: string,
  needed: Capability,
  reply: FastifyReply,
): Promise<Channel | undefined> {
  const ch = await getChannel(channelId);
  if (!ch || ch.workspaceId !== identity.workspaceId) {
    reply.code(404).send({ error: "channel not found" });
    return undefined;
  }
  const isMember = await isChannelMember(channelId, identity.memberId);
  const explicit = await getCapability(identity.workspaceId, identity.memberId, "channel", channelId);
  const effective = effectiveCapability(explicit, isMember);
  if (!effective) {
    reply.code(403).send({ error: "not a channel member" });
    return undefined;
  }
  if (!satisfies(effective, needed)) {
    reply.code(403).send({ error: `requires ${needed} capability` });
    return undefined;
  }
  return ch;
}
