/**
 * The owner BRIEF → real session entry point (#235, builds on #123/#164).
 *
 * The dashboard's brief composer lets the owner hand the fleet a goal: pick a department lead and say
 * "go get us paying founders for ipop.ai". That is exactly an @mention post in the lead's department
 * channel — so this service POSTS the brief as the owner human, persists the @mention, and then runs the
 * SAME audited launch path as a typed @mention ({@link MarketingMentionService}, the #68 auth gate → #59
 * `SubagentService` gate → #96 venture gate → #71 admission → session). It introduces NO new launch
 * authority: it is a thin, deterministic front door onto the existing trigger that returns the launched
 * sessions to the caller (so the composer can confirm a real session spawned, rather than relying on the
 * best-effort post-time fan-out).
 *
 * Safety / injection: the brief body is `@<lead> <goal>` — the @mention is a fixed structural prefix and
 * the goal is OWNER-authored data, posted AS the owner. The launched agents still carry only draft tools,
 * so anything that leaves the building stays #13-gated; no send/publish/spend is reachable from a brief.
 * A launch denial (kill switch / budget) throws out of `launch` and propagates exactly as the @mention
 * path does (the app maps it to 402/429); the brief message is already on the record, the work is not.
 */
import type {
  MarketingMentionResult,
  LaunchedMention,
  ConnectPrompted,
  ModelBlocked,
  DedupedMention,
} from "./mention.js";

export interface MarketingBriefDeps {
  /** Resolve a department lead by @handle → its department + channel (pure blueprint lookup). */
  resolveLead(handle: string): { handle: string; department: string; channel: string } | undefined;
  /** A channel by name in this workspace, or undefined (the fleet hasn't been seeded yet). */
  getChannelByName(workspaceId: string, name: string): Promise<{ id: string } | undefined>;
  /** Post the brief AS the owner human into the lead's channel. */
  post(input: {
    workspaceId: string;
    channelId: string;
    authorMemberId: string;
    body: string;
  }): Promise<{ id: string }>;
  /** Persist the @mention on the just-posted message so the launch path can resolve the lead. */
  recordMentions(input: {
    workspaceId: string;
    channelId: string;
    messageId: string;
    authorMemberId: string;
    body: string;
  }): Promise<void>;
  /** The existing @mention → real session launcher (the audited #59/#96/#71 path). */
  launch(
    identity: { workspaceId: string; memberId: string },
    input: {
      channelId: string;
      messageId: string;
      task: string;
      /**
       * #417: thread a governed a2a handoff's out-of-band authorization to the #59 gate so the launch
       * skips the human channel-RBAC head (never the venture gate). Absent/false ⇒ the human/owner brief
       * path is byte-for-byte unchanged.
       */
      systemAuthorized?: boolean;
    },
  ): Promise<MarketingMentionResult>;
  /**
   * #370 (optional): narrate the lead's kickoff into its department channel — the lead posts its plan AS
   * the agent member so the coordination view fills like reload.chat. Default-absent ⇒ today's behavior
   * (no agent post). Best-effort and self-gating (default-OFF, owner-first); never affects the launch.
   */
  notifyKickoff?(input: {
    workspaceId: string;
    agentHandle: string;
    channel: string;
    goal: string;
  }): Promise<void>;
  /** Optional paid-plan gate for parallel campaign lanes (#1290). Absent preserves today's behavior. */
  campaignLaneQuota?(workspaceId: string): Promise<
    | { ok: true }
    | {
        ok: false;
        code: 402 | 403;
        error: string;
        resource: "active_campaign_lanes";
        limit: number;
        used: number;
        planKey: string;
        upgradeTrigger: string;
      }
  >;
}

export type MarketingBriefResult =
  | {
      ok: true;
      lead: string;
      department: string;
      channelId: string;
      messageId: string;
      launched: LaunchedMention[];
      connectPrompted: ConnectPrompted[];
      modelBlocked: ModelBlocked[];
      /** Personas skipped as a duplicate of an open task (#322); [] when dedup is off. */
      deduped: DedupedMention[];
    }
  | {
      ok: false;
      code: number;
      error: string;
      resource?: string;
      limit?: number;
      used?: number;
      planKey?: string;
      upgradeTrigger?: string;
    };

export class MarketingBriefService {
  constructor(private readonly deps: MarketingBriefDeps) {}

  async brief(
    identity: { workspaceId: string; memberId: string },
    input: {
      lead: string;
      goal: string;
      /**
       * #417: when set (the #282 a2a dispatch path), the launch is authorized out-of-band by
       * {@link decideA2ACall}; thread it to the launcher so the #9 channel-RBAC head is skipped. The
       * venture/admission gate still runs. Absent ⇒ today's human/owner brief, unchanged.
       */
      systemAuthorized?: boolean;
    },
  ): Promise<MarketingBriefResult> {
    const goal = input.goal.trim();
    if (goal.length === 0) {
      return { ok: false, code: 400, error: "a brief needs a goal" };
    }
    const lead = this.deps.resolveLead(input.lead.trim().replace(/^@/, "").toLowerCase());
    if (!lead) {
      return { ok: false, code: 400, error: "unknown department lead" };
    }
    const channel = await this.deps.getChannelByName(identity.workspaceId, lead.channel);
    if (!channel) {
      return { ok: false, code: 409, error: "this department hasn't been hired yet — activate the fleet first" };
    }
    const quota = await this.deps.campaignLaneQuota?.(identity.workspaceId);
    if (quota && !quota.ok) return quota;

    // The @mention is a fixed structural prefix; the goal is owner-authored data (never tool instructions).
    const body = `@${lead.handle} ${goal}`;
    const message = await this.deps.post({
      workspaceId: identity.workspaceId,
      channelId: channel.id,
      authorMemberId: identity.memberId,
      body,
    });
    // Persist the @mention so the launch path resolves the lead. (We post via the repo directly, so the
    // shared post-time marketing trigger does NOT also fire — no double launch.)
    await this.deps.recordMentions({
      workspaceId: identity.workspaceId,
      channelId: channel.id,
      messageId: message.id,
      authorMemberId: identity.memberId,
      body,
    });

    const result = await this.deps.launch(identity, {
      channelId: channel.id,
      messageId: message.id,
      task: goal,
      systemAuthorized: input.systemAuthorized,
    });
    if (!result.ok) return result;
    // #370: the lead posts its plan into the department channel on kickoff (best-effort, self-gating). The
    // launch already succeeded and is on the record; narration must never fail the brief, so it is wrapped.
    if (this.deps.notifyKickoff) {
      try {
        await this.deps.notifyKickoff({
          workspaceId: identity.workspaceId,
          agentHandle: lead.handle,
          channel: lead.channel,
          goal,
        });
      } catch {
        // best-effort narration — the audited launch path is unaffected
      }
    }
    return {
      ok: true,
      lead: lead.handle,
      department: lead.department,
      channelId: channel.id,
      messageId: message.id,
      launched: result.launched,
      connectPrompted: result.connectPrompted,
      modelBlocked: result.modelBlocked,
      deduped: result.deduped,
    };
  }
}
