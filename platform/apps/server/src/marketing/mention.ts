/**
 * The @mention → real session trigger (#123, ADR-0123).
 *
 * Mentioning a department agent in its channel spawns a REAL harness session through the audited #59
 * `SubagentService` gate (injected here as `invoke`) whose launcher is the venture-gated SessionManager
 * (#84/#96) — so the launch passes the #96 gate AND the #71 admission chokepoint (kill switch, tenant
 * budget, concurrency). The session runs AS the persona member, scoped to its tools, and threads its
 * result back under the @mention message (existing #25/#59 behavior). Each launch is recorded as a
 * durable `marketing_tasks` row.
 *
 * Safety: a launch denial (kill switch / budget) surfaces as a thrown `AdmissionError` from `invoke`
 * and propagates to the app error handler (→ 402/429) — NO task row is written. RBAC denials from the
 * SubagentService come back as `{ok:false}` and are returned verbatim.
 */

export type InvokeResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: number; error: string };

export interface MarketingMentionDeps {
  getChannel(channelId: string): Promise<{ id: string; workspaceId: string; name: string | null } | undefined>;
  isMarketingChannel(name: string | null): boolean;
  /** Personas @-mentioned on the message (#6/#59), in mention order. */
  personaMentions(workspaceId: string, messageId: string): Promise<Array<{ id: string; agentMemberId: string; name: string }>>;
  /** The #59 SubagentService gate, bound to the venture-gated launcher. */
  invoke(
    identity: { workspaceId: string; memberId: string },
    input: { personaId: string; channelId: string; task: string; messageId: string },
  ): Promise<InvokeResult>;
  /** Record a durable mention task record. */
  recordTask(input: {
    workspaceId: string;
    channelId: string;
    department: string;
    agentMemberId: string;
    sessionId: string;
    kind: "mention";
    task: string;
    createdByMemberId: string;
    messageId: string;
  }): Promise<{ id: string }>;
  departmentForHandle(handle: string): string | undefined;
}

export interface LaunchedMention {
  personaId: string;
  handle: string;
  department: string;
  sessionId: string;
  taskId: string;
}

export type MarketingMentionResult =
  | { ok: true; launched: LaunchedMention[] }
  | { ok: false; code: number; error: string };

export class MarketingMentionService {
  constructor(private readonly deps: MarketingMentionDeps) {}

  async launch(
    identity: { workspaceId: string; memberId: string },
    input: { channelId: string; messageId: string; task?: string },
  ): Promise<MarketingMentionResult> {
    const channel = await this.deps.getChannel(input.channelId);
    if (!channel || channel.workspaceId !== identity.workspaceId) {
      return { ok: false, code: 404, error: "channel not found" };
    }
    if (!this.deps.isMarketingChannel(channel.name)) {
      return { ok: false, code: 400, error: "not a marketing channel" };
    }

    const personas = await this.deps.personaMentions(identity.workspaceId, input.messageId);
    if (personas.length === 0) {
      return { ok: false, code: 400, error: "no marketing agents are mentioned on this message" };
    }

    const launched: LaunchedMention[] = [];
    for (const persona of personas) {
      const department = this.deps.departmentForHandle(persona.name);
      if (!department) continue; // a mentioned non-marketing persona is skipped here
      const task = input.task ?? `@${persona.name}`;
      // A denial (kill switch / budget) throws out of `invoke` and propagates — no task is recorded.
      const result = await this.deps.invoke(identity, {
        personaId: persona.id,
        channelId: input.channelId,
        task: input.task ?? task,
        messageId: input.messageId,
      });
      if (!result.ok) return { ok: false, code: result.code, error: result.error };
      const record = await this.deps.recordTask({
        workspaceId: identity.workspaceId,
        channelId: input.channelId,
        department,
        agentMemberId: persona.agentMemberId,
        sessionId: result.sessionId,
        kind: "mention",
        task: input.task ?? task,
        createdByMemberId: identity.memberId,
        messageId: input.messageId,
      });
      launched.push({
        personaId: persona.id,
        handle: persona.name,
        department,
        sessionId: result.sessionId,
        taskId: record.id,
      });
    }

    if (launched.length === 0) {
      return { ok: false, code: 400, error: "no marketing agents are mentioned on this message" };
    }
    return { ok: true, launched };
  }
}
