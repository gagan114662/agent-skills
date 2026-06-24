import { describe, it, expect } from "vitest";
import { newId } from "../../../src/db/id.js";
import { seedMarketingDepartment, type MarketingSeedDeps } from "../../../src/marketing/seed.js";
import {
  MARKET_DISCOVERY_TASK,
  MARKETING_CHANNELS,
  MARKETING_DEPARTMENTS,
} from "../../../src/marketing/blueprint.js";

/**
 * #123 seeding — idempotent, reuse-first. Drives the seeder with in-memory fakes for every #4/#9/#59
 * seam so it runs in the no-DB unit job. Asserts the agency it builds: ten channels, eight agents, the
 * human granted propagate (so they may @mention-invoke), intros posted, and a welcome session + task
 * record per department proving each agent alive — and that re-seeding creates nothing twice.
 */
function makeFakes() {
  const channels = new Map<string, { id: string; name: string }>(); // name → channel
  const personas = new Map<string, { id: string; agentMemberId: string }>(); // handle → persona
  const channelMembers: Array<{ channelId: string; memberId: string }> = [];
  const grants: Array<{ memberId: string; channelId: string; capability: string }> = [];
  const posts: Array<{ channelId: string; agentMemberId: string; body: string }> = [];
  const launches: Array<{ channelId: string; agentMemberId: string; task: string }> = [];
  const tasks: Array<{ department: string; agentMemberId: string; sessionId: string | null; kind: string; task: string }> = [];

  const deps: MarketingSeedDeps = {
    getChannelByName: async (_wid, name) => channels.get(name),
    createChannel: async ({ name }) => {
      const ch = { id: `ch-${newId()}`, name };
      channels.set(name, ch);
      return ch;
    },
    addChannelMember: async (channelId, memberId) => {
      if (!channelMembers.some((m) => m.channelId === channelId && m.memberId === memberId)) {
        channelMembers.push({ channelId, memberId });
      }
    },
    grantPropagate: async ({ memberId, channelId }) => {
      grants.push({ memberId, channelId, capability: "propagate" });
    },
    getPersonaByHandle: async (_wid, handle) => personas.get(handle),
    createPersona: async ({ name }) => {
      const p = { id: `p-${newId()}`, agentMemberId: `am-${newId()}` };
      personas.set(name, p);
      return p;
    },
    post: async ({ channelId, agentMemberId, body }) => {
      posts.push({ channelId, agentMemberId, body });
      return { id: `msg-${newId()}` };
    },
    launchWelcome: async ({ channelId, agentMemberId, task }) => {
      launches.push({ channelId, agentMemberId, task });
      return { id: `sess-${newId()}` };
    },
    recordTask: async ({ department, agentMemberId, sessionId, kind, task }) => {
      tasks.push({ department, agentMemberId, sessionId, kind, task });
      return { id: `mt-${newId()}` };
    },
    hasMarketingTarget: async () => true,
  };
  return { deps, channels, personas, channelMembers, grants, posts, launches, tasks };
}

describe("#123 seedMarketingDepartment", () => {
  const workspaceId = "ws-1";
  const human = "human-1";

  it("creates all ten channels, eight agents, grants, intros and welcome tasks", async () => {
    const f = makeFakes();
    const result = await seedMarketingDepartment(
      { workspaceId, createdByMemberId: human, postWelcomeTasks: true },
      f.deps,
    );

    // Ten channels, eight agents.
    expect([...f.channels.keys()].sort()).toEqual([...MARKETING_CHANNELS].sort());
    expect(f.personas.size).toBe(8);
    expect(result.channels).toHaveLength(10);
    expect(result.agents).toHaveLength(8);

    // The human is granted propagate on every seeded channel (so they may @mention-invoke).
    expect(new Set(f.grants.map((g) => g.channelId)).size).toBe(10);
    expect(f.grants.every((g) => g.memberId === human && g.capability === "propagate")).toBe(true);

    // Each agent is a member of its own department channel + the two shared channels.
    const scout = result.agents.find((a) => a.handle === "scout")!;
    const seo = f.channels.get("seo")!;
    expect(f.channelMembers).toContainEqual({ channelId: seo.id, memberId: scout.agentMemberId });
    for (const shared of ["general", "launch"]) {
      const ch = f.channels.get(shared)!;
      expect(f.channelMembers).toContainEqual({ channelId: ch.id, memberId: scout.agentMemberId });
    }

    // Intros posted + a welcome message in #general; a welcome session + task per department.
    expect(f.posts.length).toBeGreaterThanOrEqual(MARKETING_DEPARTMENTS.length + 1);
    expect(f.launches).toHaveLength(8);
    expect(f.tasks).toHaveLength(8);
    expect(f.tasks.every((t) => t.kind === "welcome" && t.sessionId !== null)).toBe(true);
    expect(result.welcomeTasks).toHaveLength(8);
  });

  it("is idempotent — re-seeding creates no new channels, agents, or grants", async () => {
    const f = makeFakes();
    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: false }, f.deps);
    const channelsAfterFirst = f.channels.size;
    const personasAfterFirst = f.personas.size;

    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: false }, f.deps);
    expect(f.channels.size).toBe(channelsAfterFirst);
    expect(f.personas.size).toBe(personasAfterFirst);
  });

  it("skips welcome sessions when postWelcomeTasks is false", async () => {
    const f = makeFakes();
    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: false }, f.deps);
    expect(f.launches).toHaveLength(0);
    expect(f.tasks).toHaveLength(0);
  });

  it("a denied welcome launch keeps the venture created-but-paused and never throws (#226/#227)", async () => {
    // The dogfooded dead-end: the first founding launch is denied (kill switch / admission cap), and the old
    // seeder threw it as a 429 — discarding a venture it had just created. Now the venture stands up and the
    // seed succeeds with zero welcome tasks (created-but-paused), so the console renders it, never an empty desk.
    const f = makeFakes();
    let created = false;
    const deps: MarketingSeedDeps = {
      ...f.deps,
      ensureFirstVenture: async () => {
        const wasCreated = !created;
        created = true;
        return { ideaId: "idea-1", created: wasCreated };
      },
      launchWelcome: async () => {
        throw new Error("launch denied: tenant_capacity");
      },
    };

    const result = await seedMarketingDepartment(
      { workspaceId, createdByMemberId: human, postWelcomeTasks: true },
      deps,
    );
    expect(result.venture).toEqual({ ideaId: "idea-1", created: true });
    expect(result.welcomeTasks).toHaveLength(0);
    expect(f.tasks).toHaveLength(0);
  });

  it("re-seeding a workspace that already has a venture launches NOTHING — no admission hit (#227)", async () => {
    // The activation idempotency key is "the workspace already has a venture", not "has welcome tasks": even
    // when the first activation's launches were all denied (so there are zero welcome tasks), a re-seed must
    // not relaunch — that was the 429 trap. `ensureFirstVenture` reporting `created:false` means activated.
    const f = makeFakes();
    const deps: MarketingSeedDeps = {
      ...f.deps,
      ensureFirstVenture: async () => ({ ideaId: "idea-1", created: false }),
    };

    const result = await seedMarketingDepartment(
      { workspaceId, createdByMemberId: human, postWelcomeTasks: true },
      deps,
    );
    expect(result.venture).toEqual({ ideaId: "idea-1", created: false });
    expect(f.launches).toHaveLength(0);
    expect(result.welcomeTasks).toHaveLength(0);
  });

  it("drives the venture through the loop on activation and folds its brief into the welcome tasks (#230)", async () => {
    // Activation must produce REAL work: the venture is driven to a funded epic, and each lead's welcome
    // session is pointed at that venture (not a generic hello) so the launched sessions work the venture.
    const f = makeFakes();
    const activateCalls: Array<{ ideaId: string }> = [];
    const deps: MarketingSeedDeps = {
      ...f.deps,
      ensureFirstVenture: async () => ({ ideaId: "idea-1", created: true }),
      activateVenture: async ({ ideaId }) => {
        activateCalls.push({ ideaId });
        return { epicTaskId: "epic-1", iterations: 1, verdict: "FUND", brief: "VENTURE_BRIEF_MARKER" };
      },
    };

    const result = await seedMarketingDepartment(
      { workspaceId, createdByMemberId: human, postWelcomeTasks: true },
      deps,
    );

    expect(activateCalls).toEqual([{ ideaId: "idea-1" }]);
    expect(result.venture).toMatchObject({ ideaId: "idea-1", created: true, epicTaskId: "epic-1", iterations: 1, verdict: "FUND" });
    // Every welcome session's task carries the venture brief so the launched session works the venture.
    expect(f.launches).toHaveLength(8);
    expect(f.launches.every((l) => l.task.includes("VENTURE_BRIEF_MARKER"))).toBe(true);
  });

  it("launches market discovery first when no target is set and briefs downstream welcomes with the stored context (#883)", async () => {
    const f = makeFakes();
    const deps: MarketingSeedDeps = {
      ...f.deps,
      hasMarketingTarget: async () => false,
      storeDiscoveryContext: async ({ task }) => {
        expect(task).toBe(MARKET_DISCOVERY_TASK);
        return { id: "mem-discovery-1" };
      },
      ensureFirstVenture: async () => ({ ideaId: "idea-1", created: true }),
      activateVenture: async () => ({
        epicTaskId: "epic-1",
        iterations: 1,
        verdict: "FUND",
        brief: "VENTURE_BRIEF_MARKER",
      }),
    };

    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: true }, deps);

    expect(f.launches).toHaveLength(9);
    expect(f.launches[0]!.task).toBe(MARKET_DISCOVERY_TASK);
    expect(f.tasks[0]).toMatchObject({ department: "discovery", kind: "discovery", task: MARKET_DISCOVERY_TASK });
    const downstream = f.launches.slice(1);
    expect(downstream).toHaveLength(8);
    expect(downstream.every((l) => l.task.includes("VENTURE_BRIEF_MARKER"))).toBe(true);
    expect(downstream.every((l) => l.task.includes("Market discovery prerequisite"))).toBe(true);
    expect(downstream.every((l) => l.task.includes("mem-discovery-1"))).toBe(true);
  });

  it("keeps the venture and still launches when the kickoff fails — no infinite hang (#230)", async () => {
    // A kickoff failure must not discard the venture or block the welcome launches; the diagnostic
    // surfaces the reason. The welcome task falls back to the plain copy (no brief).
    const f = makeFakes();
    const deps: MarketingSeedDeps = {
      ...f.deps,
      ensureFirstVenture: async () => ({ ideaId: "idea-1", created: true }),
      activateVenture: async () => {
        throw new Error("kickoff failed: scorer unavailable");
      },
    };

    const result = await seedMarketingDepartment(
      { workspaceId, createdByMemberId: human, postWelcomeTasks: true },
      deps,
    );

    expect(result.venture).toMatchObject({ ideaId: "idea-1", created: true });
    expect(f.launches).toHaveLength(8); // launches still fired
  });

  it("posts intros only on creation — re-seeding an existing agency posts no new messages (#138)", async () => {
    // The boot backfill (#138) re-runs the seeder on every restart for existing workspaces. Intros and
    // the #general welcome must be posted once (when an agent/channel is first created), never again,
    // or every reboot would spam the rooms. Channel/persona creation is already idempotent; this guards
    // the message side.
    const f = makeFakes();
    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: false }, f.deps);
    const postsAfterFirst = f.posts.length;
    expect(postsAfterFirst).toBeGreaterThanOrEqual(MARKETING_DEPARTMENTS.length + 1); // 8 intros + welcome

    await seedMarketingDepartment({ workspaceId, createdByMemberId: human, postWelcomeTasks: false }, f.deps);
    expect(f.posts.length).toBe(postsAfterFirst); // nothing new on re-seed
  });
});
