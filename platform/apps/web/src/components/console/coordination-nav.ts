/**
 * Reload.chat sidebar model (#378) — a PURE projection of the EXISTING store (channels + directory) into
 * the three reload.chat sidebar sections: PINNED, CHANNELS, and DIRECT MESSAGES. No new backend, no new
 * state: it just re-shapes data the store already holds so the left panel reads like reload.chat (a flat
 * search → pinned → department channels → people list).
 *
 * SAFETY (#200): every value here is DATA. Names come straight from the channel/directory records and are
 * rendered as React text by the sidebar (never markup), so an agent- or channel-authored string can never
 * become instructions or widen scope. This module opens NO action path — selecting a DM only ever resolves
 * to an EXISTING channel id (or null); it never creates a channel or a backend resource.
 */
import type { Channel } from "../../api/types.js";
import type { DirectoryEntry } from "../../store/store.js";
import { AGENT_DEPARTMENT, agentColor, departmentColor } from "../../brand.js";

/**
 * The canonical department-channel order for the CHANNELS section (the reload.chat fixed list the issue
 * names: seo · social · content · email · ads · analytics · brand · general), with `reach` folded in so the
 * eighth department (#123 Comet) is never orphaned to PINNED. Any public channel NOT in this set is an
 * owner-created extra and surfaces under PINNED instead.
 */
export const CHANNEL_ORDER = [
  "seo",
  "social",
  "content",
  "email",
  "ads",
  "analytics",
  "brand",
  "reach",
  "general",
] as const;

const CHANNEL_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  CHANNEL_ORDER.map((name, i) => [name, i]),
);

/** One channel row in the sidebar. `color` is the department spectrum hue (undefined for non-department). */
export interface SidebarChannel {
  readonly id: string;
  readonly name: string;
  readonly color?: string;
}

/** One direct-message row: a workspace member (human or agent) presented as a person you can message. */
export interface SidebarDm {
  readonly memberId: string;
  readonly displayName: string;
  readonly kind: "human" | "agent";
  /** The agent's spectrum hue (its presence/accent dot); undefined for humans. */
  readonly color?: string;
  /** True for the signed-in member (rendered as "(you)"). */
  readonly self: boolean;
}

export interface SidebarModel {
  /** Owner-created channels outside the canonical department set (e.g. #launch, #random). */
  readonly pinned: readonly SidebarChannel[];
  /** The department channels, in canonical order. */
  readonly channels: readonly SidebarChannel[];
  /** Humans + agent personas, agents first, each alpha; the signed-in member is flagged `self`. */
  readonly dms: readonly SidebarDm[];
}

function normalize(q: string | null | undefined): string {
  return (q ?? "").trim().toLowerCase();
}

/** Lowercased first token of a display name ("Scout Vega" → "scout") — the @-handle the spectrum keys on. */
function handleOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
}

/**
 * Build the three sidebar sections from the live store. `query` (the search box) filters every section by a
 * case-insensitive substring on the visible name; an empty query shows everything. Pure + total: it never
 * throws on missing/odd data (a null channel name is simply dropped from the lists).
 */
export function buildSidebarModel(
  channels: readonly Channel[],
  directory: Record<string, DirectoryEntry>,
  selfId: string | null | undefined,
  query?: string,
): SidebarModel {
  const q = normalize(query);
  const matches = (name: string): boolean => q === "" || name.toLowerCase().includes(q);

  const publicChannels = channels.filter((c) => c.kind === "public" && !c.isArchived && c.name);

  const channelRows: SidebarChannel[] = [];
  const pinnedRows: SidebarChannel[] = [];
  for (const c of publicChannels) {
    const name = c.name as string;
    if (!matches(name)) continue;
    const row: SidebarChannel = { id: c.id, name, color: departmentColor(name) };
    if (name in CHANNEL_RANK) channelRows.push(row);
    else pinnedRows.push(row);
  }
  channelRows.sort((a, b) => (CHANNEL_RANK[a.name] ?? 0) - (CHANNEL_RANK[b.name] ?? 0));
  pinnedRows.sort((a, b) => a.name.localeCompare(b.name));

  const dms: SidebarDm[] = Object.values(directory)
    .filter((m) => matches(m.displayName))
    .map((m) => ({
      memberId: m.id,
      displayName: m.displayName,
      kind: m.kind,
      color: m.kind === "agent" ? agentColor(m.displayName) : undefined,
      self: m.id === selfId,
    }))
    .sort((a, b) => {
      // Agents first (they're the DM targets the owner reaches for), then humans; each alphabetical.
      if (a.kind !== b.kind) return a.kind === "agent" ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });

  return { pinned: pinnedRows, channels: channelRows, dms };
}

/**
 * Resolve a DM row to the EXISTING channel that hosts the 1:1 with that member, or null if none exists.
 *
 * For an agent persona this is its department channel — in ipop you talk to Scout in #seo, to Lens in
 * #analytics — so opening the DM opens that agent's working channel (a real conversation, real history),
 * which is the honest 1:1 surface without inventing a per-agent DM backend. For anyone else (a human, or an
 * agent with no mapped department) it falls back to an existing `dm`-kind channel named after the member.
 * Returns null when nothing resolves — the caller treats that as a safe no-op (the row still lists the
 * member; #200: we never create a channel to satisfy a click).
 */
export function resolveDmChannelId(
  member: Pick<DirectoryEntry, "displayName" | "kind">,
  channels: readonly Channel[],
): string | null {
  if (member.kind === "agent") {
    const dept = AGENT_DEPARTMENT[handleOf(member.displayName)];
    if (dept) {
      const deptChannel = channels.find((c) => c.kind === "public" && !c.isArchived && c.name === dept);
      if (deptChannel) return deptChannel.id;
    }
  }
  const target = member.displayName.trim().toLowerCase();
  const dm = channels.find((c) => c.kind === "dm" && (c.name ?? "").trim().toLowerCase() === target);
  return dm?.id ?? null;
}
