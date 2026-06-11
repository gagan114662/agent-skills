import {
  BRAND_VOICE,
  MARKETING_DEPARTMENTS,
  SHARED_CHANNELS,
  type MarketingDepartment,
} from "./blueprint.js";

/**
 * Seed the marketing department fleet for a workspace (#123, ADR-0123), idempotent and reuse-first.
 *
 * Every side effect is an injected seam (the #4 channels, #9 grants, #59 personas, #25 launcher, #5
 * poster) so the orchestration runs in the no-DB unit job; `marketing/default.ts` binds the real repos.
 * Idempotency: a channel is matched by name and a persona by handle, so re-seeding never duplicates or
 * rotates a token. The human creator is granted `propagate` on every seeded channel so they may
 * @mention-invoke (the #59 delegation gate). When `postWelcomeTasks` is set, one real welcome session
 * per department is launched through the (venture-gated) launcher and recorded as a durable task —
 * the proof each agent is alive.
 */

export interface MarketingSeedDeps {
  /** A channel by name in this workspace, or undefined. */
  getChannelByName(workspaceId: string, name: string): Promise<{ id: string } | undefined>;
  /** Create a public channel. */
  createChannel(input: { workspaceId: string; name: string }): Promise<{ id: string; name: string }>;
  /** Add a member to a channel (idempotent). */
  addChannelMember(channelId: string, memberId: string): Promise<void>;
  /** Grant a member `propagate` on a channel (idempotent upsert). */
  grantPropagate(input: {
    workspaceId: string;
    memberId: string;
    channelId: string;
    grantedByMemberId: string;
  }): Promise<void>;
  /** A persona by @handle in this workspace, or undefined. */
  getPersonaByHandle(workspaceId: string, handle: string): Promise<{ id: string; agentMemberId: string } | undefined>;
  /** Mint a persona (agent member + token + prompt + tool ceiling). */
  createPersona(spec: {
    workspaceId: string;
    name: string;
    systemPrompt: string;
    allowedTools: string[];
    model: string | null;
    createdByMemberId: string;
  }): Promise<{ id: string; agentMemberId: string }>;
  /** Post a message to a channel as an agent member (#5 poster). */
  post(input: { workspaceId: string; channelId: string; agentMemberId: string; body: string }): Promise<{ id: string }>;
  /** Launch a real welcome session for an agent (optional — omitted = no welcome sessions). */
  launchWelcome?(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
  }): Promise<{ id: string }>;
  /** Record a durable task record (optional — paired with `launchWelcome`). */
  recordTask?(input: {
    workspaceId: string;
    channelId: string;
    department: string;
    agentMemberId: string;
    sessionId: string | null;
    kind: "welcome" | "mention";
    task: string;
    createdByMemberId: string;
  }): Promise<{ id: string }>;
}

export interface SeededAgent {
  id: string;
  agentMemberId: string;
  handle: string;
  department: string;
}

export interface MarketingSeedResult {
  channels: Array<{ id: string; name: string }>;
  agents: SeededAgent[];
  welcomeTasks: Array<{ id: string }>;
}

export interface MarketingSeedInput {
  workspaceId: string;
  createdByMemberId: string;
  /** Launch + record one welcome session per department (default false). */
  postWelcomeTasks?: boolean;
}

async function ensureChannel(
  deps: MarketingSeedDeps,
  workspaceId: string,
  name: string,
): Promise<{ id: string; name: string }> {
  const existing = await deps.getChannelByName(workspaceId, name);
  if (existing) return { id: existing.id, name };
  return deps.createChannel({ workspaceId, name });
}

async function ensurePersona(
  deps: MarketingSeedDeps,
  workspaceId: string,
  createdByMemberId: string,
  dept: MarketingDepartment,
): Promise<{ id: string; agentMemberId: string }> {
  const existing = await deps.getPersonaByHandle(workspaceId, dept.agent.handle);
  if (existing) return existing;
  return deps.createPersona({
    workspaceId,
    name: dept.agent.handle,
    systemPrompt: dept.agent.systemPrompt,
    allowedTools: [...dept.agent.allowedTools],
    model: dept.agent.model,
    createdByMemberId,
  });
}

export async function seedMarketingDepartment(
  input: MarketingSeedInput,
  deps: MarketingSeedDeps,
): Promise<MarketingSeedResult> {
  const { workspaceId, createdByMemberId } = input;

  // 1. Ensure every channel (department + shared), then put the human in each with `propagate` so they
  //    may post and @mention-invoke.
  const channelByName = new Map<string, { id: string; name: string }>();
  for (const name of [...MARKETING_DEPARTMENTS.map((d) => d.channel), ...SHARED_CHANNELS]) {
    const ch = await ensureChannel(deps, workspaceId, name);
    channelByName.set(name, ch);
    await deps.addChannelMember(ch.id, createdByMemberId);
    await deps.grantPropagate({ workspaceId, memberId: createdByMemberId, channelId: ch.id, grantedByMemberId: createdByMemberId });
  }
  const sharedChannelIds = SHARED_CHANNELS.map((n) => channelByName.get(n)!.id);

  // 2. Ensure each agent persona, place it in its department channel + the shared rooms, and post its
  //    brand-voice intro.
  const agents: SeededAgent[] = [];
  for (const dept of MARKETING_DEPARTMENTS) {
    const persona = await ensurePersona(deps, workspaceId, createdByMemberId, dept);
    const channel = channelByName.get(dept.channel)!;
    await deps.addChannelMember(channel.id, persona.agentMemberId);
    for (const sharedId of sharedChannelIds) await deps.addChannelMember(sharedId, persona.agentMemberId);
    await deps.post({ workspaceId, channelId: channel.id, agentMemberId: persona.agentMemberId, body: dept.agent.intro });
    agents.push({ id: persona.id, agentMemberId: persona.agentMemberId, handle: dept.agent.handle, department: dept.key });
  }

  // 3. The collective welcome in #general, posted as the first agent.
  const general = channelByName.get("general")!;
  if (agents.length > 0) {
    await deps.post({ workspaceId, channelId: general.id, agentMemberId: agents[0]!.agentMemberId, body: BRAND_VOICE.welcome });
  }

  // 4. Optionally launch one real welcome session per department (proves each agent alive) + record it.
  const welcomeTasks: Array<{ id: string }> = [];
  if (input.postWelcomeTasks && deps.launchWelcome && deps.recordTask) {
    for (let i = 0; i < MARKETING_DEPARTMENTS.length; i++) {
      const dept = MARKETING_DEPARTMENTS[i]!;
      const agent = agents[i]!;
      const channel = channelByName.get(dept.channel)!;
      const session = await deps.launchWelcome({
        workspaceId,
        channelId: channel.id,
        agentMemberId: agent.agentMemberId,
        createdByMemberId,
        task: dept.welcomeTask,
      });
      const task = await deps.recordTask({
        workspaceId,
        channelId: channel.id,
        department: dept.key,
        agentMemberId: agent.agentMemberId,
        sessionId: session.id,
        kind: "welcome",
        task: dept.welcomeTask,
        createdByMemberId,
      });
      welcomeTasks.push(task);
    }
  }

  return { channels: [...channelByName.values()], agents, welcomeTasks };
}
