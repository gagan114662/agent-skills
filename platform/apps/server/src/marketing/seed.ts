import {
  BRAND_VOICE,
  MARKET_DISCOVERY_TASK,
  MARKETING_DEPARTMENTS,
  SHARED_CHANNELS,
  marketDiscoveryContextDirective,
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
    kind: "welcome" | "mention" | "discovery";
    task: string;
    createdByMemberId: string;
  }): Promise<{ id: string }>;
  /** True when the workspace has already supplied structured marketing target context (#502). */
  hasMarketingTarget?(workspaceId: string): Promise<boolean>;
  /** Persist the discovery prompt/context anchor so later agents can refer back to it. */
  storeDiscoveryContext?(input: {
    workspaceId: string;
    task: string;
    createdByMemberId: string;
  }): Promise<{ id: string }>;
  /**
   * Create the workspace's first venture in the pipeline if it has none (#221), so an activated console is
   * never an empty `0/0/0` pipeline — the founding team has something to clock into. Idempotent: returns
   * the existing venture (`created: false`) on a re-seed. Optional — omitted ⇒ no venture is created (the
   * #138 boot backfill / signup auto-seed don't activate a pipeline, only the explicit first-run CTA does).
   */
  ensureFirstVenture?(input: {
    workspaceId: string;
    createdByMemberId: string;
  }): Promise<{ ideaId: string; created: boolean }>;
  /**
   * Drive the freshly-created venture through the #96 loop so activation produces REAL work (#230): a
   * funded venture with an epic + first tasks, never an inert `intake` row the console sits on forever
   * ("clocking in… hang tight"). Idempotent (a venture that already has an epic is returned unchanged),
   * so it is safe on a re-seed and on the boot backfill. Returns the epic id, iteration count, verdict,
   * and a short `brief` the welcome sessions fold into each lead's first task so the launched sessions
   * are pointed at the real venture. Optional — omitted ⇒ the venture is created but not driven (the
   * no-DB unit job / a deployment without the venture service wired).
   */
  activateVenture?(input: {
    workspaceId: string;
    ideaId: string;
    createdByMemberId: string;
  }): Promise<{ epicTaskId: string | null; iterations: number; verdict: string; brief: string }>;
  /**
   * How many welcome tasks the workspace already has (#221) — a FALLBACK idempotency key for activation,
   * used only when {@link ensureFirstVenture} is not wired (e.g. the no-DB unit job). When the venture
   * seam is present, "the workspace already has a venture" is the authoritative key instead (#226/#227),
   * because a first activation whose launches were all denied has a venture but zero welcome tasks — and
   * must still be treated as activated so a re-seed never re-hits the admission cap. Optional — omitted ⇒ 0.
   */
  countWelcomeTasks?(workspaceId: string): Promise<number>;
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
  /**
   * The workspace's first venture (#221), present once activation has run (`postWelcomeTasks`). `created`
   * is true only on the seed that first stood it up; a re-seed echoes the same venture with `created: false`.
   * Once driven through the #96 loop (#230), `epicTaskId`/`iterations`/`verdict` describe the funded venture
   * the team is working — `epicTaskId` null means the kickoff seam wasn't wired or it failed (the latter is
   * surfaced via the activation diagnostic, never as an infinite "clocking in").
   */
  venture?: {
    ideaId: string;
    created: boolean;
    epicTaskId?: string | null;
    iterations?: number;
    verdict?: string;
  };
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
): Promise<{ id: string; name: string; created: boolean }> {
  const existing = await deps.getChannelByName(workspaceId, name);
  if (existing) return { id: existing.id, name, created: false };
  const ch = await deps.createChannel({ workspaceId, name });
  return { ...ch, created: true };
}

async function ensurePersona(
  deps: MarketingSeedDeps,
  workspaceId: string,
  createdByMemberId: string,
  dept: MarketingDepartment,
): Promise<{ id: string; agentMemberId: string; created: boolean }> {
  const existing = await deps.getPersonaByHandle(workspaceId, dept.agent.handle);
  if (existing) return { ...existing, created: false };
  const persona = await deps.createPersona({
    workspaceId,
    name: dept.agent.handle,
    systemPrompt: dept.agent.systemPrompt,
    allowedTools: [...dept.agent.allowedTools],
    model: dept.agent.model,
    createdByMemberId,
  });
  return { ...persona, created: true };
}

export async function seedMarketingDepartment(
  input: MarketingSeedInput,
  deps: MarketingSeedDeps,
): Promise<MarketingSeedResult> {
  const { workspaceId, createdByMemberId } = input;

  // 1. Ensure every channel (department + shared), then put the human in each with `propagate` so they
  //    may post and @mention-invoke. `grantPropagate` is an idempotent upsert, so re-seeding is safe.
  const channelByName = new Map<string, { id: string; name: string }>();
  const channelCreated = new Set<string>();
  for (const name of [...MARKETING_DEPARTMENTS.map((d) => d.channel), ...SHARED_CHANNELS]) {
    const ch = await ensureChannel(deps, workspaceId, name);
    channelByName.set(name, { id: ch.id, name: ch.name });
    if (ch.created) channelCreated.add(name);
    await deps.addChannelMember(ch.id, createdByMemberId);
    await deps.grantPropagate({ workspaceId, memberId: createdByMemberId, channelId: ch.id, grantedByMemberId: createdByMemberId });
  }
  const sharedChannelIds = SHARED_CHANNELS.map((n) => channelByName.get(n)!.id);

  // 2. Ensure each agent persona, place it in its department channel + the shared rooms. The intro is
  //    posted **only when the persona is first created** — so the #138 boot backfill can re-run on every
  //    restart for existing workspaces without ever re-spamming the rooms (membership adds are idempotent).
  const agents: SeededAgent[] = [];
  for (const dept of MARKETING_DEPARTMENTS) {
    const persona = await ensurePersona(deps, workspaceId, createdByMemberId, dept);
    const channel = channelByName.get(dept.channel)!;
    await deps.addChannelMember(channel.id, persona.agentMemberId);
    for (const sharedId of sharedChannelIds) await deps.addChannelMember(sharedId, persona.agentMemberId);
    if (persona.created) {
      await deps.post({ workspaceId, channelId: channel.id, agentMemberId: persona.agentMemberId, body: dept.agent.intro });
    }
    agents.push({ id: persona.id, agentMemberId: persona.agentMemberId, handle: dept.agent.handle, department: dept.key });
  }

  // 3. The collective welcome in #general, posted as the first agent — only when #general is first
  //    created (same once-only rule as the intros above).
  if (agents.length > 0 && channelCreated.has("general")) {
    const general = channelByName.get("general")!;
    await deps.post({ workspaceId, channelId: general.id, agentMemberId: agents[0]!.agentMemberId, body: BRAND_VOICE.welcome });
  }

  // 4. Activation (#221, hardened by #226/#227): turn a seeded org into a venture that always renders.
  //
  //    (a) Stand up the workspace's first venture so the pipeline is never an empty 0/0/0 desk — there is
  //        something for the founding team to clock into. `ensureFirstVenture` no-ops when one exists. This
  //        is the durable activation success: it is a DB row, NOT a launch, so it consumes no #71 admission
  //        slot and can never 429. The console drives its empty-state strictly off "the workspace has a
  //        venture" (#226), so once this row exists the founder never sees the empty desk again.
  //
  //    (b) The activation idempotency key is now "the workspace already has a venture" (#226/#227): once it
  //        does, a re-seed launches NOTHING and so never touches the admission chokepoint — that was the
  //        429 dead-end on a second click. (Fall back to the welcome-task count only when no venture seam
  //        is wired, e.g. the no-DB unit job.)
  //
  //    (c) On the FIRST activation we open each lead's first task best-effort. A launch denial (admission
  //        cap / kill switch / venture gate / no runtime) must NEVER discard the venture we just created:
  //        we keep the venture + any sessions that did open and stop, so the console renders the venture
  //        created-but-paused rather than throwing the founder a 429 dead-end. The denial is honest (no
  //        work is faked) — the venture itself is the activation proof, not the welcome sessions.
  const welcomeTasks: Array<{ id: string }> = [];
  let venture: MarketingSeedResult["venture"];
  let ventureBrief: string | undefined;
  if (input.postWelcomeTasks && deps.launchWelcome && deps.recordTask) {
    if (deps.ensureFirstVenture) {
      venture = await deps.ensureFirstVenture({ workspaceId, createdByMemberId });
      // #230: drive the venture through the #96 loop NOW so activation produces real work — a funded
      // venture with an epic + first tasks — instead of an inert intake row the console hangs on. This
      // runs whether or not the venture is brand new (kickoff is idempotent), so a re-seed of an
      // already-created-but-undriven venture (the live bug: epicTaskId null / iterations 0) gets fixed
      // too. Best-effort: a kickoff failure must NOT discard the venture or block the welcome launches —
      // the activation diagnostic surfaces the reason instead of throwing the founder a dead end.
      if (deps.activateVenture && venture) {
        try {
          const kicked = await deps.activateVenture({ workspaceId, ideaId: venture.ideaId, createdByMemberId });
          venture = {
            ...venture,
            epicTaskId: kicked.epicTaskId,
            iterations: kicked.iterations,
            verdict: kicked.verdict,
          };
          ventureBrief = kicked.brief;
        } catch {
          // Keep the venture; the console's "why nothing running" diagnostic explains it (no infinite hang).
        }
      }
    }
    const alreadyActivated = venture
      ? !venture.created
      : deps.countWelcomeTasks
        ? (await deps.countWelcomeTasks(workspaceId)) > 0
        : false;
    if (!alreadyActivated) {
      const needsDiscovery = deps.hasMarketingTarget ? !(await deps.hasMarketingTarget(workspaceId)) : true;
      let discoveryDirective: string | undefined;
      if (needsDiscovery) {
        const discoveryMemory = deps.storeDiscoveryContext
          ? await deps.storeDiscoveryContext({
              workspaceId,
              task: MARKET_DISCOVERY_TASK,
              createdByMemberId,
            })
          : undefined;
        discoveryDirective = marketDiscoveryContextDirective(discoveryMemory?.id);
        const discoveryDept =
          MARKETING_DEPARTMENTS.find((d) => d.key === "reach") ?? MARKETING_DEPARTMENTS[0]!;
        const discoveryAgent =
          agents.find((a) => a.department === discoveryDept.key) ?? agents[0]!;
        const discoveryChannel = channelByName.get(discoveryDept.channel)!;
        try {
          const session = await deps.launchWelcome({
            workspaceId,
            channelId: discoveryChannel.id,
            agentMemberId: discoveryAgent.agentMemberId,
            createdByMemberId,
            task: MARKET_DISCOVERY_TASK,
          });
          const task = await deps.recordTask({
            workspaceId,
            channelId: discoveryChannel.id,
            department: "discovery",
            agentMemberId: discoveryAgent.agentMemberId,
            sessionId: session.id,
            kind: "discovery",
            task: MARKET_DISCOVERY_TASK,
            createdByMemberId,
          });
          welcomeTasks.push(task);
        } catch {
          return { channels: [...channelByName.values()], agents, welcomeTasks, venture };
        }
      }
      for (let i = 0; i < MARKETING_DEPARTMENTS.length; i++) {
        const dept = MARKETING_DEPARTMENTS[i]!;
        const agent = agents[i]!;
        const channel = channelByName.get(dept.channel)!;
        const baseTask = ventureBrief ? `${dept.welcomeTask}\n\n${ventureBrief}` : dept.welcomeTask;
        const taskWithContext = discoveryDirective ? `${baseTask}\n\n${discoveryDirective}` : baseTask;
        let session: { id: string };
        try {
          session = await deps.launchWelcome({
            workspaceId,
            channelId: channel.id,
            agentMemberId: agent.agentMemberId,
            createdByMemberId,
            // #230: fold the venture brief into the lead's first task so the launched session works the
            // real founding venture (not a generic hello). Falls back to the plain welcome task if the
            // kickoff didn't run (e.g. the no-DB unit job).
            task: taskWithContext,
          });
        } catch {
          // Keep the venture (+ any sessions already opened) and stop — never re-throw. A blocked launch
          // leaves the venture created-but-paused, which the console renders honestly (#226/#227), instead
          // of collapsing a successful activation into a 429 the founder can only re-fire into the wall.
          break;
        }
        const task = await deps.recordTask({
          workspaceId,
          channelId: channel.id,
          department: dept.key,
          agentMemberId: agent.agentMemberId,
          sessionId: session.id,
          kind: "welcome",
          task: taskWithContext,
          createdByMemberId,
        });
        welcomeTasks.push(task);
      }
    }
  }

  return { channels: [...channelByName.values()], agents, welcomeTasks, venture };
}
