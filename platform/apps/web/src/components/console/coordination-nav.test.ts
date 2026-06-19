/**
 * coordination-nav (#378) — the pure reload.chat sidebar projection. Proves the three sections (PINNED /
 * CHANNELS / DIRECT MESSAGES) are shaped correctly from the live store, the search filter is honoured, and
 * a DM resolves to the EXISTING channel that hosts the 1:1 (an agent → its department channel) — never a
 * fabricated one.
 */
import { describe, expect, it } from "vitest";
import type { Channel } from "../../api/types.js";
import type { DirectoryEntry } from "../../store/store.js";
import { buildSidebarModel, resolveDmChannelId, CHANNEL_ORDER } from "./coordination-nav.js";

function chan(id: string, name: string | null, kind: Channel["kind"] = "public"): Channel {
  return { id, workspaceId: "w1", kind, name, isArchived: false };
}

const DEPARTMENT_CHANNELS: Channel[] = [
  chan("c-general", "general"),
  chan("c-seo", "seo"),
  chan("c-analytics", "analytics"),
  chan("c-brand", "brand"),
  chan("c-launch", "launch"), // owner extra → PINNED
];

const DIRECTORY: Record<string, DirectoryEntry> = {
  me1: { id: "me1", kind: "human", displayName: "Ada" },
  ag1: { id: "ag1", kind: "agent", displayName: "Scout" },
  ag2: { id: "ag2", kind: "agent", displayName: "Lens" },
  hr2: { id: "hr2", kind: "human", displayName: "Ben" },
};

describe("buildSidebarModel", () => {
  it("splits canonical department channels (CHANNELS) from owner extras (PINNED), each ordered", () => {
    const m = buildSidebarModel(DEPARTMENT_CHANNELS, DIRECTORY, "me1");
    expect(m.channels.map((c) => c.name)).toEqual(["seo", "analytics", "brand", "general"]);
    // Canonical order is preserved (seo before analytics before brand before general).
    const order = m.channels.map((c) => CHANNEL_ORDER.indexOf(c.name as (typeof CHANNEL_ORDER)[number]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The owner-created channel lands in PINNED, not CHANNELS.
    expect(m.pinned.map((c) => c.name)).toEqual(["launch"]);
  });

  it("colours department channels with their spectrum hue", () => {
    const m = buildSidebarModel(DEPARTMENT_CHANNELS, DIRECTORY, "me1");
    const seo = m.channels.find((c) => c.name === "seo");
    expect(seo?.color).toBe("#ff4524");
  });

  it("lists humans + agents as DMs, agents first, self flagged", () => {
    const m = buildSidebarModel(DEPARTMENT_CHANNELS, DIRECTORY, "me1");
    expect(m.dms.map((d) => d.displayName)).toEqual(["Lens", "Scout", "Ada", "Ben"]);
    expect(m.dms.find((d) => d.memberId === "me1")?.self).toBe(true);
    // Agents carry an accent colour; humans do not.
    expect(m.dms.find((d) => d.displayName === "Scout")?.color).toBe("#ff4524");
    expect(m.dms.find((d) => d.displayName === "Ada")?.color).toBeUndefined();
  });

  it("filters every section by the search query (case-insensitive substring)", () => {
    const m = buildSidebarModel(DEPARTMENT_CHANNELS, DIRECTORY, "me1", "le"); // matches "Lens"
    expect(m.channels).toHaveLength(0);
    expect(m.pinned).toHaveLength(0);
    expect(m.dms.map((d) => d.displayName)).toEqual(["Lens"]);
  });

  it("drops archived + nameless channels", () => {
    const channels: Channel[] = [
      { id: "a", workspaceId: "w1", kind: "public", name: "seo", isArchived: true },
      { id: "b", workspaceId: "w1", kind: "public", name: null, isArchived: false },
      chan("c-general", "general"),
    ];
    const m = buildSidebarModel(channels, {}, null);
    expect(m.channels.map((c) => c.name)).toEqual(["general"]);
    expect(m.dms).toHaveLength(0);
  });
});

describe("resolveDmChannelId", () => {
  it("resolves an agent DM to its department channel (the 1:1 surface)", () => {
    expect(resolveDmChannelId({ displayName: "Scout", kind: "agent" }, DEPARTMENT_CHANNELS)).toBe("c-seo");
    expect(resolveDmChannelId({ displayName: "Lens", kind: "agent" }, DEPARTMENT_CHANNELS)).toBe("c-analytics");
  });

  it("falls back to an existing dm-kind channel named after the member", () => {
    const channels = [...DEPARTMENT_CHANNELS, chan("dm-ben", "Ben", "dm")];
    expect(resolveDmChannelId({ displayName: "Ben", kind: "human" }, channels)).toBe("dm-ben");
  });

  it("returns null when nothing resolves (caller treats as a safe no-op — never creates a channel)", () => {
    // An agent with no mapped department and no matching dm channel.
    expect(resolveDmChannelId({ displayName: "Atlas", kind: "agent" }, DEPARTMENT_CHANNELS)).toBeNull();
    // A human with no dm channel.
    expect(resolveDmChannelId({ displayName: "Ada", kind: "human" }, DEPARTMENT_CHANNELS)).toBeNull();
  });
});
