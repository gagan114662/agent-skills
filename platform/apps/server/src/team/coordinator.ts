import type { TeamArtifact, TeamArtifactKind, TeamEvent, TeamEventKind } from "@reload/shared";
import type { HarnessKind } from "../runtime/harness.js";
import type { LaunchInput, SessionLogger } from "../runtime/manager.js";
import {
  noopTracer,
  type AgentTracer,
  type TeamSpanContext,
  type TeamTrace,
} from "../observability/tracing.js";
import type { TeamChannel } from "./channel.js";

/**
 * The launch surface the coordinator drives. {@link SessionManager} satisfies this structurally —
 * `launch` returns immediately (the run continues server-side) and `join` awaits completion. Tests
 * inject a fake to assert the concurrency cap and failure isolation without a runtime or DB.
 */
export interface TeamLauncher {
  launch(input: LaunchInput): Promise<{ id: string }>;
  join(id: string): Promise<void>;
}

/** One unit of parallel work in a team run: an agent, its prompt, and the branch it owns. */
export interface Subtask {
  /** Stable id for this subtask within the run (used in every team event). */
  subtaskId: string;
  /** The agent member that will execute it (and author its team events). */
  agentMemberId: string;
  /** The task/prompt handed to the agent (passed to the harness as data). */
  task: string;
  /** The branch the agent works on — recorded on the subtask's team events. */
  branch: string;
  /** Optional ordered phase. All phase 1 work completes before phase 2 starts, etc. */
  phase?: number;
  /** Artifact kinds this subtask promises to produce for downstream teammates. */
  producesArtifacts?: TeamArtifactKind[];
  /** Artifact kinds that must exist before this subtask may launch. */
  requiresArtifacts?: TeamArtifactKind[];
  /** Optional per-subtask harness override. Codex operator lanes use this to make Codex the actual brain. */
  preferredHarness?: HarnessKind;
}

export interface TeamRunInput {
  workspaceId: string;
  channelId: string;
  createdByMemberId: string;
  /** Unique id grouping every session + event of this run. */
  teamRunId: string;
  subtasks: Subtask[];
}

/** Per-subtask outcome (the run as a whole never rejects — failures are isolated and reported). */
export interface SubtaskResult {
  subtaskId: string;
  sessionId: string | null;
  ok: boolean;
  visibilityDegraded?: boolean;
  error?: string;
}

export interface TeamRunResult {
  teamRunId: string;
  results: SubtaskResult[];
  visibilityDegraded: boolean;
}

export interface TeamCoordinatorDeps {
  launcher: TeamLauncher;
  channel: TeamChannel;
  /** Max sessions in flight at once — the team-level cap that keeps us under the sandbox budget. */
  maxConcurrency: number;
  logger: SessionLogger;
  /** Observability seam; defaults to the no-op so tests/CI never touch the network. */
  tracer?: AgentTracer;
  /** Injectable clock for deterministic event timestamps in tests. */
  now?: () => string;
}

function subtaskLaneSummary(task: string): string {
  if (task.toLowerCase().includes("audit_label: codex_operator_lane")) {
    return "Codex operator lane";
  }
  const contextLine = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("You are "));
  const match = /^You are\s+(.+?)\s+in ipop's live marketing room\..*?Your lane is\s+(.+?)\.$/i.exec(
    contextLine ?? "",
  );
  if (match) return match[1] + " " + match[2];
  return task;
}

function normalizePhase(phase: number | undefined): number {
  if (typeof phase !== "number" || !Number.isInteger(phase) || phase <= 0) return 1;
  return phase;
}

function uniqueArtifactKinds(kinds: readonly TeamArtifactKind[] | undefined): TeamArtifactKind[] {
  return [...new Set(kinds ?? [])];
}

function artifactLabel(kind: TeamArtifactKind): string {
  if (kind === "scout_research") return "Scout research artifact";
  if (kind === "brand_voice") return "Workspace brand voice profile";
  if (kind === "draft_set") return "Validated channel-native draft set";
  if (kind === "lens_review") return "Lens rubric review";
  return kind;
}

function artifactProductionInstructions(
  input: TeamRunInput,
  subtask: Subtask,
  kinds: readonly TeamArtifactKind[],
): string {
  if (kinds.length === 0) return "";
  const sections = kinds.map((kind) => {
    if (kind === "scout_research") return [
      "- scout_research: post one valid team milestone event when your research is ready.",
      "  The line must start with ::team-event:: followed by JSON with this exact shape:",
      "  {",
      '    "teamRunId": "' + input.teamRunId + '",',
      '    "subtaskId": "' + subtask.subtaskId + '",',
      '    "agentMemberId": "' + subtask.agentMemberId + '",',
      '    "kind": "milestone",',
      '    "summary": "research artifact ready: <domain or target>",',
      '    "branch": "' + subtask.branch + '",',
      '    "createdAt": "<current ISO timestamp>",',
      '    "artifact": {',
      '      "kind": "scout_research",',
      '      "schemaVersion": 1,',
      '      "siteSummary": "<what this business does, from the site/source>",',
      '      "icp": "<specific buyer/user/persona>",',
      '      "positioning": "<plain positioning angle and why-now>",',
      '      "proofPoints": ["<specific claim from source>", "<specific claim from source>"],',
      '      "competitors": ["<competitor or alternative>", "<competitor or alternative>"],',
      '      "toneNotes": "<voice/tone notes observed from the source>",',
      '      "sourceUrls": ["<source URL used>"]',
      "    }",
      "  }",
    ].join("\n");
    if (kind === "brand_voice") return [
      "- brand_voice: post one valid team milestone event when the workspace voice profile is ready.",
      "  Seed it from the customer's public site, owner brief, and any observed owner edits; do not invent a voice.",
      "  The line must start with ::team-event:: followed by JSON with this exact shape:",
      "  {",
      '    "teamRunId": "' + input.teamRunId + '",',
      '    "subtaskId": "' + subtask.subtaskId + '",',
      '    "agentMemberId": "' + subtask.agentMemberId + '",',
      '    "kind": "milestone",',
      '    "summary": "brand voice ready: <domain or target>",',
      '    "branch": "' + subtask.branch + '",',
      '    "createdAt": "<current ISO timestamp>",',
      '    "artifact": {',
      '      "kind": "brand_voice",',
      '      "schemaVersion": 1,',
      '      "profile": {',
      '        "toneAxes": ["<tone axis, e.g. plain over hype>"],',
      '        "vocabularyDo": ["<words or phrasing to prefer>"],',
      '        "vocabularyDont": ["<words or phrasing to avoid>"],',
      '        "sentenceRhythm": "<short description of cadence and sentence length>",',
      '        "exampleLines": ["<approved-sounding line in this voice>"]',
      "      },",
      '      "sourceUrls": ["<source URL or owner edit source used>"]',
      "    }",
      "  }",
    ].join("\n");
    if (kind === "draft_set") return [
      "- draft_set: post one valid team milestone event when your channel-native drafts are ready.",
      "  The line must start with ::team-event:: followed by JSON with this exact envelope:",
      "  {",
      '    "teamRunId": "' + input.teamRunId + '",',
      '    "subtaskId": "' + subtask.subtaskId + '",',
      '    "agentMemberId": "' + subtask.agentMemberId + '",',
      '    "kind": "milestone",',
      '    "summary": "draft set ready: <domain or target>",',
      '    "branch": "' + subtask.branch + '",',
      '    "createdAt": "<current ISO timestamp>",',
      '    "artifact": { "kind": "draft_set", "schemaVersion": 1, "drafts": [ ... ] }',
      "  }",
      "  Each draft needs format, title, fields, and citations from Scout proofPoints/sourceUrls.",
      "  Supported formats and hard validator rules:",
      "  - google_rsa: fields.headlines = exactly 15 strings, each <=30 chars; fields.descriptions = exactly 4 strings, each <=90 chars.",
      "  - meta_ad: fields.hook/body/cta required; hook <=125 chars; headline <=40; description <=30.",
      "  - linkedin_post: fields.hook/body required; hook <=180 chars; cta <=120.",
      "  - x_thread: fields.tweets = 2 to 8 strings, each <=280 chars.",
      "  - email: subject <=45, preheader <=90, body/cta/plainTextAlt required, no spam-trigger phrasing.",
      "  - landing_hero: headline <=70, subhead <=160, cta <=30.",
      "  - seo_snippet: title <=60, metaDescription 150-160 chars, intent required.",
    ].join("\n");
    if (kind === "lens_review") return [
      "- lens_review: post one valid team milestone event when the rubric review is ready.",
      "  Score every draft in the injected draft_set against the injected brand_voice profile before any owner-visible handoff treats it as ready.",
      "  The line must start with ::team-event:: followed by JSON with this exact envelope:",
      "  {",
      '    "teamRunId": "' + input.teamRunId + '",',
      '    "subtaskId": "' + subtask.subtaskId + '",',
      '    "agentMemberId": "' + subtask.agentMemberId + '",',
      '    "kind": "milestone",',
      '    "summary": "lens review ready: <domain or target>",',
      '    "branch": "' + subtask.branch + '",',
      '    "createdAt": "<current ISO timestamp>",',
      '    "artifact": {',
      '      "kind": "lens_review",',
      '      "schemaVersion": 1,',
      '      "threshold": 4,',
      '      "summary": "<overall quality verdict>",',
      '      "reviews": [',
      "        {",
      '          "format": "<same draft format>",',
      '          "title": "<same draft title>",',
      '          "scores": {',
      '            "specificityToBusiness": 1,',
      '            "hookStrength": 1,',
      '            "clarity": 1,',
      '            "evidenceUse": 1,',
      '            "ctaQuality": 1,',
      '            "voiceConsistency": 1',
      "          },",
      '          "averageScore": 1,',
      '          "revisionNote": "<one concrete revision instruction>",',
      '          "revisedDraft": { "...": "required only when averageScore is below threshold" }',
      "        }",
      "      ]",
      "    }",
      "  }",
      "  Rubric scores are integers from 1 to 5; averageScore must match the computed average.",
      "  Score dimensions: specificityToBusiness, hookStrength, clarity, evidenceUse, ctaQuality, voiceConsistency.",
      "  If a draft averageScore is below threshold, include one revisedDraft that still passes its channel validator.",
      "  Do not send, post, publish, or spend; the existing human approval gates remain in charge.",
    ].join("\n");
    return "- " + kind;
  });
  return [
    "Required team artifact production contract",
    "Do not mark this lane complete until the required artifact event is posted.",
    ...sections,
  ].join("\n");
}

function artifactConsumptionInstructions(artifacts: readonly TeamArtifact[]): string {
  if (artifacts.length === 0) return "";
  return [
    "Required upstream team artifacts",
    "The coordinator validated these artifacts before launch. Use their concrete facts in the work product.",
    "Every draft you produce must cite which proofPoints, sourceUrls, or brand_voice rules it used; do not invent claims outside this JSON.",
    JSON.stringify(artifacts, null, 2),
  ].join("\n");
}

/**
 * TeamCoordinator — runs N agents in parallel on one feature, each on its own subtask/branch,
 * keeping them in the loop through the shared team channel (Team Mode).
 *
 *   - Concurrency: an async worker pool keeps at most `maxConcurrency` sessions in flight, so we
 *     never exceed the sandbox budget. The existing per-session `ResourceCaps` still apply
 *     unchanged via the underlying SessionManager.
 *   - Failure isolation: each subtask runs independently; one agent failing posts a `blocked`
 *     event and is reported as `{ ok: false }` while the others run to completion. `runTeam` never
 *     rejects.
 *   - Observability: the whole run is wrapped in one team rollup span; each child session links
 *     under it (via `parentSpanId`) so the run reviews as one team in Braintrust.
 */
export class TeamCoordinator {
  private readonly tracer: AgentTracer;
  private readonly now: () => string;
  private readonly pendingAnnouncements: Array<{
    workspaceId: string;
    channelId: string;
    event: TeamEvent;
  }> = [];

  constructor(private readonly deps: TeamCoordinatorDeps) {
    this.tracer = deps.tracer ?? noopTracer;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async runTeam(input: TeamRunInput): Promise<TeamRunResult> {
    const results: SubtaskResult[] = new Array<SubtaskResult>(input.subtasks.length);

    const body = async (ctx: TeamSpanContext): Promise<{ completed: number; failed: number }> => {
      const entries = input.subtasks
        .map((subtask, index) => ({
          subtask,
          index,
          phase: normalizePhase(subtask.phase),
        }))
        .sort((a, b) => (a.phase === b.phase ? a.index - b.index : a.phase - b.phase));
      const phases = [...new Set(entries.map((entry) => entry.phase))];
      for (const phase of phases) {
        const phaseEntries = entries.filter((entry) => entry.phase === phase);
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const entry = phaseEntries[next++];
            if (!entry) return;
            results[entry.index] = await this.runSubtask(input, entry.subtask, ctx.parentSpanId);
          }
        };
        // At most maxConcurrency sessions in flight; never spawn more workers than phase subtasks.
        const workers = Math.max(1, Math.min(this.deps.maxConcurrency, phaseEntries.length));
        await Promise.all(Array.from({ length: workers }, () => worker()));
      }
      const completed = results.filter((r) => r.ok).length;
      return { completed, failed: results.length - completed };
    };

    const trace: TeamTrace = {
      teamRunId: input.teamRunId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      subtaskCount: input.subtasks.length,
    };
    // Wrap the run in the team rollup span when the tracer supports it; otherwise run plainly.
    if (this.tracer.team) {
      await this.tracer.team(trace, body);
    } else {
      await body({});
    }
    return {
      teamRunId: input.teamRunId,
      results,
      visibilityDegraded: results.some((r) => r.visibilityDegraded),
    };
  }

  /** Read a channel's recent team events (peers catching up before they act). */
  async readEvents(channelId: string, opts?: { limit?: number }): Promise<TeamEvent[]> {
    await this.flushPending(channelId);
    return this.deps.channel.readRecentEvents(channelId, opts);
  }

  /** Drive one subtask end to end, isolating any failure from its peers. */
  private async runSubtask(
    input: TeamRunInput,
    subtask: Subtask,
    parentSpanId: string | undefined,
  ): Promise<SubtaskResult> {
    let visibilityDegraded = false;
    const lane = subtaskLaneSummary(subtask.task);
    const prepared = await this.prepareTask(input, subtask);
    if (!prepared.ok) {
      const delivered = await this.announce(input, subtask, "blocked", prepared.error);
      return {
        subtaskId: subtask.subtaskId,
        sessionId: null,
        ok: false,
        error: prepared.error,
        visibilityDegraded: !delivered,
      };
    }
    let delivered = await this.announce(input, subtask, "started", `started: ${lane}`);
    visibilityDegraded = visibilityDegraded || !delivered;
    try {
      const { id } = await this.deps.launcher.launch({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        agentMemberId: subtask.agentMemberId,
        createdByMemberId: input.createdByMemberId,
        task: prepared.task,
        harness: subtask.preferredHarness,
        teamRunId: input.teamRunId,
        parentSpanId,
      });
      await this.deps.launcher.join(id);
      const missingProducedArtifacts = await this.missingProducedArtifacts(input, subtask);
      if (missingProducedArtifacts.length > 0) {
        const error =
          "blocked: missing produced artifact: " + missingProducedArtifacts.map(artifactLabel).join(", ");
        delivered = await this.announce(input, subtask, "blocked", error);
        visibilityDegraded = visibilityDegraded || !delivered;
        return { subtaskId: subtask.subtaskId, sessionId: id, ok: false, error, visibilityDegraded };
      }
      delivered = await this.announce(input, subtask, "done", `done: ${lane}`);
      visibilityDegraded = visibilityDegraded || !delivered;
      return { subtaskId: subtask.subtaskId, sessionId: id, ok: true, visibilityDegraded };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.logger.error({ err: error, subtaskId: subtask.subtaskId }, "team subtask failed");
      delivered = await this.announce(input, subtask, "blocked", `blocked: ${error}`);
      visibilityDegraded = visibilityDegraded || !delivered;
      return {
        subtaskId: subtask.subtaskId,
        sessionId: null,
        ok: false,
        error,
        visibilityDegraded,
      };
    }
  }

  private async prepareTask(
    input: TeamRunInput,
    subtask: Subtask,
  ): Promise<{ ok: true; task: string } | { ok: false; error: string }> {
    const requiredKinds = uniqueArtifactKinds(subtask.requiresArtifacts);
    const producedKinds = uniqueArtifactKinds(subtask.producesArtifacts);
    const sections: string[] = [];
    if (requiredKinds.length > 0) {
      const events = await this.readEvents(input.channelId, { limit: 200 });
      const artifacts: TeamArtifact[] = [];
      for (const kind of requiredKinds) {
        const candidates = events
          .filter((event) => event.teamRunId === input.teamRunId)
          .map((event) => event.artifact)
          .filter((candidate): candidate is TeamArtifact => candidate?.kind === kind);
        const artifact = candidates.at(-1);
        if (!artifact) {
          return {
            ok: false,
            error: "blocked: missing required artifact: " + artifactLabel(kind),
          };
        }
        artifacts.push(artifact);
      }
      sections.push(artifactConsumptionInstructions(artifacts));
    }
    if (producedKinds.length > 0) {
      sections.push(artifactProductionInstructions(input, subtask, producedKinds));
    }
    if (sections.length === 0) return { ok: true, task: subtask.task };
    return { ok: true, task: sections.join("\n\n") + "\n\n" + subtask.task };
  }

  private async missingProducedArtifacts(input: TeamRunInput, subtask: Subtask): Promise<TeamArtifactKind[]> {
    const producedKinds = uniqueArtifactKinds(subtask.producesArtifacts);
    if (producedKinds.length === 0) return [];
    const events = await this.readEvents(input.channelId, { limit: 200 });
    return producedKinds.filter(
      (kind) =>
        !events.some(
          (event) =>
            event.teamRunId === input.teamRunId &&
            event.subtaskId === subtask.subtaskId &&
            event.artifact?.kind === kind,
        ),
    );
  }

  /** Post a coordinator-authored lifecycle event to the team channel (queued on failure). */
  private async announce(
    input: TeamRunInput,
    subtask: Subtask,
    kind: TeamEventKind,
    summary: string,
  ): Promise<boolean> {
    const event: TeamEvent = {
      teamRunId: input.teamRunId,
      subtaskId: subtask.subtaskId,
      agentMemberId: subtask.agentMemberId,
      kind,
      summary,
      branch: subtask.branch,
      createdAt: this.now(),
    };
    const flushed = await this.flushPending(input.channelId);
    try {
      await this.deps.channel.postEvent({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        event,
      });
      return flushed;
    } catch (err) {
      this.pendingAnnouncements.push({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        event,
      });
      this.deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err), kind },
        "team event post failed; queued for retry",
      );
      return false;
    }
  }

  private async flushPending(channelId: string): Promise<boolean> {
    let flushedAll = true;
    for (let i = 0; i < this.pendingAnnouncements.length; ) {
      const pending = this.pendingAnnouncements[i];
      if (!pending || pending.channelId !== channelId) {
        i += 1;
        continue;
      }
      try {
        await this.deps.channel.postEvent(pending);
        this.pendingAnnouncements.splice(i, 1);
      } catch (err) {
        flushedAll = false;
        this.deps.logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            kind: pending.event.kind,
            subtaskId: pending.event.subtaskId,
          },
          "queued team event retry failed",
        );
        i += 1;
      }
    }
    return flushedAll;
  }
}
