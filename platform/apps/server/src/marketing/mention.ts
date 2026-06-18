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
import { findDuplicateOpenTask, type DedupeOpenTask } from "./dedup.js";

export type InvokeResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: number; error: string };

/**
 * Subscription-first auth gate (#68, ADR-0068). When the deployment harness needs model auth and a
 * workspace hasn't connected a Claude account, the persona posts a friendly connect prompt INSTEAD of
 * launching — so a real @mention never crashes or silently dies, and never burns an admission slot or
 * budget on a session that couldn't run. Absent (or `required:false`, i.e. the demo harness) → no
 * gate, today's behavior. Per-tenant: `hasAuth` is always called with the caller's workspace.
 */
export interface MarketingAuthGate {
  /** True when the deployment harness requires model auth (claude-code/codex). */
  required: boolean;
  /** Whether this workspace has resolved auth (its own subscription token, or the platform fallback). */
  hasAuth(workspaceId: string): Promise<boolean>;
  /** Post the brand-voice connect prompt as the persona, threaded under the @mention. */
  postConnectPrompt(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    personaName: string;
    parentMessageId: string;
  }): Promise<{ id: string }>;
  /**
   * Optional (#365): record that a real launch found this workspace's auth UNUSABLE. Best-effort and
   * side-effect-only — it NEVER changes the gate's launch/no-launch decision. The recorder is a row-scoped
   * UPDATE, so it is a no-op for a never-connected workspace (no row) and stamps the `expired` health
   * signal only for a workspace that HAS a connected credential whose stored token no longer works.
   */
  onAuthUnavailable?(workspaceId: string): Promise<void>;
}

/** A persona that was @mentioned but couldn't run because the workspace has no Claude connected. */
export interface ConnectPrompted {
  personaId: string;
  handle: string;
  department: string;
  messageId: string;
}

/**
 * Model preflight gate (#246). When the deployment runs a real harness and the workspace's effective
 * fleet model isn't one that resolves on the subscription (the `claude-fable-5` class), the persona
 * posts an actionable "pick a valid model" prompt INSTEAD of launching — so a bad model can never crash
 * every session mid-run. Absent (or `required:false`, the demo harness) → no gate, today's behavior.
 */
export interface MarketingModelGate {
  /** True when the deployment harness requires model auth (claude-code/codex). */
  required: boolean;
  /** Resolve + validate the workspace's effective model; ok:false carries the unservable id. */
  check(workspaceId: string): Promise<{ ok: true } | { ok: false; model: string }>;
  /** Post the brand-voice "pick a valid model" prompt as the persona, threaded under the @mention. */
  postModelPrompt(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    personaName: string;
    model: string;
    parentMessageId: string;
  }): Promise<{ id: string }>;
}

/** A persona that was @mentioned but couldn't run because the workspace's fleet model is unservable. */
export interface ModelBlocked {
  personaId: string;
  handle: string;
  department: string;
  model: string;
  messageId: string;
}

/**
 * Idempotent task creation gate (#322, ADR-0322). When wired AND enabled for the workspace, a re-briefed
 * objective whose normalized text already has an OPEN task in the same department is SKIPPED — no second
 * session, no second `marketing_tasks` row, no duplicate Spend-Approval draft downstream. Absent (or
 * disabled) ⇒ today's behavior (every brief launches), so the default posture and every existing test are
 * unchanged. The dep is read-only and pure-decided in {@link findDuplicateOpenTask}.
 */
export interface MarketingDedupeGate {
  /** Whether dedup is active for this workspace (#322 default-OFF, owner-workspace-first). */
  isEnabled(workspaceId: string): Promise<boolean>;
  /** OPEN (non-terminal) department tasks to dedup against — id, department, raw objective. */
  openTasks(workspaceId: string): Promise<DedupeOpenTask[]>;
}

/** A persona whose launch was SKIPPED because an open task with the same objective already exists (#322). */
export interface DedupedMention {
  personaId: string;
  handle: string;
  department: string;
  /** The existing open task the new brief reused instead of opening a duplicate. */
  existingTaskId: string;
}

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
  /**
   * #320: optional task enrichment. Given the workspace + the raw task, return the task with a
   * workspace-context preamble (site URL + product context + brand voice) prepended — or the task
   * unchanged when context injection is OFF / no facts are on file. Absent → no enrichment (the default
   * posture and every existing launch test), so a briefed agent gets exactly the raw task as before.
   * Only the LAUNCHED task is enriched; the durable `marketing_tasks` row keeps the original goal.
   */
  enrichTask?(workspaceId: string, task: string): Promise<string>;
  /** #68: optional subscription-first auth gate. Absent → no gate (demo/local default). */
  auth?: MarketingAuthGate;
  /** #246: optional model preflight gate. Absent → no gate (demo/local default). */
  model?: MarketingModelGate;
  /** #322: optional idempotent task-creation gate. Absent → no dedup (today's behavior). */
  dedupe?: MarketingDedupeGate;
}

export interface LaunchedMention {
  personaId: string;
  handle: string;
  department: string;
  sessionId: string;
  taskId: string;
}

export type MarketingMentionResult =
  | {
      ok: true;
      launched: LaunchedMention[];
      connectPrompted: ConnectPrompted[];
      modelBlocked: ModelBlocked[];
      /** Personas whose launch was skipped as a duplicate of an open task (#322); [] when dedup is off. */
      deduped: DedupedMention[];
    }
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
    const connectPrompted: ConnectPrompted[] = [];
    const modelBlocked: ModelBlocked[] = [];
    const deduped: DedupedMention[] = [];

    // #322 idempotent task creation: when the dedup gate is wired AND enabled for this workspace, read the
    // open tasks ONCE up front. A re-briefed objective that already has an open task in the same department
    // is skipped below (no duplicate session / draft). The list grows in-memory as we launch, so two
    // personas on the same message can't open two copies of the same objective in the same department.
    const dedupeGate = this.deps.dedupe;
    const dedupeEnabled = dedupeGate ? await dedupeGate.isEnabled(identity.workspaceId) : false;
    const openTasks: DedupeOpenTask[] =
      dedupeGate && dedupeEnabled ? await dedupeGate.openTasks(identity.workspaceId) : [];

    for (const persona of personas) {
      const department = this.deps.departmentForHandle(persona.name);
      if (!department) continue; // a mentioned non-marketing persona is skipped here

      // #68 subscription-first gate: if the harness needs model auth and this workspace hasn't
      // connected a Claude account, post a friendly connect prompt as the persona and move on — no
      // launch, no admission slot, no budget. The demo harness sets required:false, so this is inert
      // for the default posture and every existing test.
      const gate = this.deps.auth;
      if (gate?.required && !(await gate.hasAuth(identity.workspaceId))) {
        // #365: observe the unusable-auth event so the owner's connection-health signal can flip to
        // `expired` (no-op for a never-connected workspace). Best-effort — a recorder failure must never
        // block the connect prompt, which is the user-facing point of this branch.
        if (gate.onAuthUnavailable) {
          try {
            await gate.onAuthUnavailable(identity.workspaceId);
          } catch {
            /* best-effort health signal; never blocks the connect prompt */
          }
        }
        const posted = await gate.postConnectPrompt({
          workspaceId: identity.workspaceId,
          channelId: input.channelId,
          agentMemberId: persona.agentMemberId,
          personaName: persona.name,
          parentMessageId: input.messageId,
        });
        connectPrompted.push({
          personaId: persona.id,
          handle: persona.name,
          department,
          messageId: posted.id,
        });
        continue;
      }

      // #246 model preflight: if the workspace's effective fleet model isn't servable, post an
      // actionable "pick a valid model" prompt as the persona and move on — no launch, no doomed
      // session, no admission slot. Runs after the auth gate (auth is the prerequisite for a launch).
      const modelGate = this.deps.model;
      if (modelGate?.required) {
        const verdict = await modelGate.check(identity.workspaceId);
        if (!verdict.ok) {
          const posted = await modelGate.postModelPrompt({
            workspaceId: identity.workspaceId,
            channelId: input.channelId,
            agentMemberId: persona.agentMemberId,
            personaName: persona.name,
            model: verdict.model,
            parentMessageId: input.messageId,
          });
          modelBlocked.push({
            personaId: persona.id,
            handle: persona.name,
            department,
            model: verdict.model,
            messageId: posted.id,
          });
          continue;
        }
      }

      const task = input.task ?? `@${persona.name}`;

      // #322 idempotent task creation: if this objective already has an OPEN task in this department, the
      // fleet is already on it — reuse it instead of opening a duplicate. No invoke, no admission slot, no
      // second `marketing_tasks` row, no duplicate Spend-Approval draft. Pure-decided; injection-safe (the
      // objective is compared as opaque data, never interpreted). Runs BEFORE #320 enrichment so the dedup
      // key is the raw human objective, not the context-augmented launch text.
      if (dedupeEnabled) {
        const dup = findDuplicateOpenTask({ department, objective: task, openTasks });
        if (dup) {
          deduped.push({ personaId: persona.id, handle: persona.name, department, existingTaskId: dup.id });
          continue;
        }
      }

      // #320: enrich the LAUNCHED task with the workspace-context preamble (site URL + product context +
      // brand voice) so the agent has real facts to act on instead of returning a placeholder. The raw
      // task is preserved for the durable `marketing_tasks` record below. Enrichment is a no-op when
      // injection is OFF / nothing is on file (the default posture), so this never changes today's behavior.
      const launchTask = this.deps.enrichTask
        ? await this.deps.enrichTask(identity.workspaceId, task)
        : task;
      // A denial (kill switch / budget) throws out of `invoke` and propagates — no task is recorded.
      const result = await this.deps.invoke(identity, {
        personaId: persona.id,
        channelId: input.channelId,
        task: launchTask,
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
      // Track the just-opened task so a later persona on the same message can dedup against it (#322).
      if (dedupeEnabled) openTasks.push({ id: record.id, department, task });
    }

    if (
      launched.length === 0 &&
      connectPrompted.length === 0 &&
      modelBlocked.length === 0 &&
      deduped.length === 0
    ) {
      return { ok: false, code: 400, error: "no marketing agents are mentioned on this message" };
    }
    return { ok: true, launched, connectPrompted, modelBlocked, deduped };
  }
}
