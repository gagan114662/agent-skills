import { describe, it, expect } from "vitest";
import {
  shouldLaunchRoomBrief,
  shouldLaunchRoomBriefForWorkspace,
  isRoomBriefChannel,
  buildRoomBriefSubtasks,
  handleRoomBriefPost,
  ROOM_BRIEF_CHANNEL,
  type RoomBriefTriggerDeps,
} from "../../src/marketing/room-brief-launch.js";
import { LAUNCH_HANDLES } from "../../src/messaging/inbound-team-launch.js";
import { DEFAULT_RUNTIME_PROVIDER } from "../../src/runtime/provider.js";

/**
 * GAP-1 (path C): a brief posted as a RAW channel message to the room's `general` channel — no
 * `/everyday` composer, no `@mention` — currently no-ops at the mention trigger, so the brief is never
 * threaded into any subtask. The team then only ever produces the ambient owner-venture ("market ipop")
 * content. This surface must behave like the external messaging bridge (Telegram/iMessage): a human
 * brief starts ONE threaded team-run whose subtasks carry the OWNER'S brief text, never a generic default.
 */
describe("room-brief launch policy (GAP-1 path C)", () => {
  const roomAgents = LAUNCH_HANDLES.map((handle) => ({ handle, agentMemberId: `mem_${handle}` }));

  describe("buildRoomBriefSubtasks", () => {
    it("threads the raw brief into every subtask, never a generic ipop default", () => {
      const brief = "market a yoga studio in Brooklyn";
      const subtasks = buildRoomBriefSubtasks(brief, roomAgents, DEFAULT_RUNTIME_PROVIDER);

      expect(subtasks.length).toBe(LAUNCH_HANDLES.length);
      for (const subtask of subtasks) {
        expect(subtask.task).toContain(brief);
        expect(subtask.task.toLowerCase()).not.toContain("launch ipop");
        expect(subtask.task.toLowerCase()).not.toContain("messaging-first");
      }
    });

    it("keeps the Scout -> Quill research handoff wiring (parity with the messaging bridge)", () => {
      const subtasks = buildRoomBriefSubtasks("grow acme.test", roomAgents, DEFAULT_RUNTIME_PROVIDER);
      const scout = subtasks.find((s) => s.branch.startsWith("messaging-scout"));
      const quill = subtasks.find((s) => s.branch.startsWith("messaging-quill"));

      expect(scout?.phase).toBe(1);
      expect(scout?.producesArtifacts).toEqual(["scout_research", "brand_voice"]);
      expect(quill?.requiresArtifacts).toEqual(["scout_research", "brand_voice"]);
      expect(quill?.producesArtifacts).toEqual(["draft_set"]);
    });

    it("skips handles with no seeded agent instead of inventing one", () => {
      const partial = [{ handle: "scout" as const, agentMemberId: "mem_scout" }];
      const subtasks = buildRoomBriefSubtasks("grow acme.test", partial, DEFAULT_RUNTIME_PROVIDER);
      expect(subtasks).toHaveLength(1);
      expect(subtasks[0]!.task).toContain("grow acme.test");
    });
  });

  describe("shouldLaunchRoomBrief", () => {
    const base = {
      authorKind: "human" as const,
      isRoomChannel: true,
      addressedPersonaCount: 0,
      body: "market a yoga studio in Brooklyn",
    };

    it("launches for a human brief in the room with no @mention", () => {
      expect(shouldLaunchRoomBrief(base)).toBe(true);
    });

    it("does not launch for an agent author (no agent->agent launch loops)", () => {
      expect(shouldLaunchRoomBrief({ ...base, authorKind: "agent" })).toBe(false);
    });

    it("does not launch when a persona is @mentioned (the mention path owns that)", () => {
      expect(shouldLaunchRoomBrief({ ...base, addressedPersonaCount: 1 })).toBe(false);
    });

    it("does not launch outside the room channel (department channels use the mention path)", () => {
      expect(shouldLaunchRoomBrief({ ...base, isRoomChannel: false })).toBe(false);
    });

    it("does not launch for trivial or blank text (not a brief)", () => {
      expect(shouldLaunchRoomBrief({ ...base, body: "hi" })).toBe(false);
      expect(shouldLaunchRoomBrief({ ...base, body: "   " })).toBe(false);
    });
  });

  describe("shouldLaunchRoomBriefForWorkspace (owner-first, default-off)", () => {
    it("is off by default even for the owner workspace", () => {
      expect(shouldLaunchRoomBriefForWorkspace({ ownerWorkspaceId: "ws_owner" }, "ws_owner")).toBe(false);
    });

    it("is on only for the owner workspace when the flag is set", () => {
      const marketing = { launchRoomBrief: true, ownerWorkspaceId: "ws_owner" };
      expect(shouldLaunchRoomBriefForWorkspace(marketing, "ws_owner")).toBe(true);
      expect(shouldLaunchRoomBriefForWorkspace(marketing, "ws_tenant")).toBe(false);
    });

    it("is off when the flag is set but no owner workspace is named", () => {
      expect(shouldLaunchRoomBriefForWorkspace({ launchRoomBrief: true }, "ws_owner")).toBe(false);
    });
  });

  describe("isRoomBriefChannel", () => {
    it("recognises the general room channel and nothing else", () => {
      expect(isRoomBriefChannel(ROOM_BRIEF_CHANNEL)).toBe(true);
      expect(isRoomBriefChannel("general")).toBe(true);
      expect(isRoomBriefChannel("seo")).toBe(false);
      expect(isRoomBriefChannel(null)).toBe(false);
    });
  });

  describe("handleRoomBriefPost", () => {
    function fakeDeps(overrides: Partial<RoomBriefTriggerDeps> = {}): {
      deps: RoomBriefTriggerDeps;
      launched: Array<{ channelId: string; messageId: string; objective: string }>;
    } {
      const launched: Array<{ channelId: string; messageId: string; objective: string }> = [];
      const deps: RoomBriefTriggerDeps = {
        isRoomChannel: (name) => isRoomBriefChannel(name),
        addressedPersonaCount: async () => 0,
        launchRoomBrief: async (input) => {
          launched.push(input);
        },
        ...overrides,
      };
      return { deps, launched };
    }

    const human = { workspaceId: "ws_owner", memberId: "owner_1", kind: "human" as const };

    it("launches a room-brief run threading the exact brief text", async () => {
      const { deps, launched } = fakeDeps();
      await handleRoomBriefPost(
        deps,
        human,
        { id: "ch_general", name: "general" },
        { id: "msg_1", body: "market a yoga studio in Brooklyn" },
      );
      expect(launched).toEqual([
        { channelId: "ch_general", messageId: "msg_1", objective: "market a yoga studio in Brooklyn" },
      ]);
    });

    it("stays silent when a persona is @mentioned (handled by the mention path)", async () => {
      const { deps, launched } = fakeDeps({ addressedPersonaCount: async () => 1 });
      await handleRoomBriefPost(
        deps,
        human,
        { id: "ch_general", name: "general" },
        { id: "msg_1", body: "@scout market a yoga studio" },
      );
      expect(launched).toEqual([]);
    });

    it("stays silent for an agent author", async () => {
      const { deps, launched } = fakeDeps();
      await handleRoomBriefPost(
        deps,
        { ...human, kind: "agent" },
        { id: "ch_general", name: "general" },
        { id: "msg_1", body: "market a yoga studio in Brooklyn" },
      );
      expect(launched).toEqual([]);
    });
  });
});
