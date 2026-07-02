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
  cancel?(id: string): Promise<boolean>;
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
  /** Per-subtask wall-clock guard. A timed-out session is canceled before retry/failure is surfaced. */
  timeoutMs?: number;
  /** Total attempts, including the first try. The route defaults this to 2 for one retry. */
  maxAttempts?: number;
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
  attempts: number;
  durationMs: number | null;
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

export type TeamTimelineState = "queued" | "running" | "done" | "failed" | "skipped";

export interface TeamRunTimelineSubtask {
  subtaskId: string;
  agentMemberId: string;
  branch: string | null;
  state: TeamTimelineState;
  input: {
    task: string | null;
    phase: number;
    producesArtifacts: TeamArtifactKind[];
    requiresArtifacts: TeamArtifactKind[];
    harness: HarnessKind | null;
    timeoutMs: number | null;
    maxAttempts: number;
  };
  attempts: number;
  sessionIds: string[];
  artifactKinds: TeamArtifactKind[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  reason: string | null;
  events: TeamEvent[];
}

export interface TeamRunTimelineAlert {
  kind: "dead_run";
  subtaskId: string;
  state: TeamTimelineState;
  reason: string;
  blockedForMs: number;
  pageOwner: true;
}

export interface TeamRunTimeline {
  teamRunId: string;
  state: TeamTimelineState;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  subtaskCount: number;
  counts: Record<TeamTimelineState, number>;
  subtasks: TeamRunTimelineSubtask[];
  alerts: TeamRunTimelineAlert[];
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_STUCK_AFTER_MS = 60 * 60 * 1000;

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

function safeSubtaskAttempts(subtask: Subtask): number {
  if (typeof subtask.maxAttempts !== "number" || !Number.isInteger(subtask.maxAttempts)) return DEFAULT_MAX_ATTEMPTS;
  return Math.max(1, Math.min(subtask.maxAttempts, 3));
}

function safeSubtaskTimeoutMs(subtask: Subtask): number | null {
  if (typeof subtask.timeoutMs !== "number" || !Number.isFinite(subtask.timeoutMs)) return null;
  return Math.max(1, Math.floor(subtask.timeoutMs));
}

function isoMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function elapsedMs(startedAt: string | null, finishedAt: string | null): number | null {
  const start = isoMs(startedAt);
  const finish = isoMs(finishedAt);
  if (start === null || finish === null || finish < start) return null;
  return finish - start;
}

function stringDetail(detail: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = detail?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function numberDetail(detail: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function artifactKindsFromEvents(events: readonly TeamEvent[]): TeamArtifactKind[] {
  return [...new Set(events.map((event) => event.artifact?.kind).filter((kind): kind is TeamArtifactKind => !!kind))];
}

function inputDetailForTimeline(subtask: Subtask): TeamRunTimelineSubtask["input"] {
  return {
    task: subtask.task.slice(0, 1200),
    phase: normalizePhase(subtask.phase),
    producesArtifacts: uniqueArtifactKinds(subtask.producesArtifacts),
    requiresArtifacts: uniqueArtifactKinds(subtask.requiresArtifacts),
    harness: subtask.preferredHarness ?? null,
    timeoutMs: safeSubtaskTimeoutMs(subtask),
    maxAttempts: safeSubtaskAttempts(subtask),
  };
}

function isSkippedBlock(event: TeamEvent): boolean {
  return event.kind === "blocked" && /missing required artifact/i.test(event.summary);
}

function stateFromEvents(events: readonly TeamEvent[]): TeamTimelineState {
  const lastTerminal = [...events].reverse().find((event) => event.kind === "done" || event.kind === "blocked");
  if (lastTerminal?.kind === "done") return "done";
  if (lastTerminal?.kind === "blocked") return isSkippedBlock(lastTerminal) ? "skipped" : "failed";
  if (events.some((event) => event.kind === "started")) return "running";
  return "queued";
}

function timelineCounts(subtasks: readonly TeamRunTimelineSubtask[]): Record<TeamTimelineState, number> {
  return subtasks.reduce<Record<TeamTimelineState, number>>(
    (counts, subtask) => {
      counts[subtask.state] += 1;
      return counts;
    },
    { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 },
  );
}

function blockSummary(error: string): string {
  return /^blocked:/i.test(error) ? error : "blocked: " + error;
}

export function buildTeamRunTimeline(
  teamRunId: string,
  events: readonly TeamEvent[],
  opts: { nowMs?: number; stuckAfterMs?: number } = {},
): TeamRunTimeline {
  const matching = events.filter((event) => event.teamRunId === teamRunId);
  const bySubtask = new Map<string, TeamEvent[]>();
  for (const event of matching) {
    const list = bySubtask.get(event.subtaskId) ?? [];
    list.push(event);
    bySubtask.set(event.subtaskId, list);
  }

  const subtasks = [...bySubtask.entries()].map<TeamRunTimelineSubtask>(([subtaskId, subtaskEvents]) => {
    const first = subtaskEvents[0]!;
    const queued = subtaskEvents.find((event) => event.kind === "queued");
    const started = subtaskEvents.find((event) => event.kind === "started");
    const terminal = [...subtaskEvents].reverse().find((event) => event.kind === "done" || event.kind === "blocked");
    const state = stateFromEvents(subtaskEvents);
    const input = queued?.detail?.input && typeof queued.detail.input === "object" && !Array.isArray(queued.detail.input)
      ? queued.detail.input as Partial<TeamRunTimelineSubtask["input"]>
      : {};
    const startedAt = started?.createdAt ?? null;
    const finishedAt = terminal?.createdAt ?? null;
    return {
      subtaskId,
      agentMemberId: first.agentMemberId,
      branch: first.branch,
      state,
      input: {
        task: typeof input.task === "string" ? input.task : null,
        phase: typeof input.phase === "number" ? input.phase : 1,
        producesArtifacts: Array.isArray(input.producesArtifacts) ? input.producesArtifacts as TeamArtifactKind[] : [],
        requiresArtifacts: Array.isArray(input.requiresArtifacts) ? input.requiresArtifacts as TeamArtifactKind[] : [],
        harness: typeof input.harness === "string" ? input.harness as HarnessKind : null,
        timeoutMs: typeof input.timeoutMs === "number" ? input.timeoutMs : null,
        maxAttempts: typeof input.maxAttempts === "number" ? input.maxAttempts : 1,
      },
      attempts: Math.max(
        0,
        ...subtaskEvents.map((event) => numberDetail(event.detail, "attempt") ?? 0),
      ),
      sessionIds: [
        ...new Set(subtaskEvents.map((event) => stringDetail(event.detail, "sessionId")).filter((id): id is string => !!id)),
      ],
      artifactKinds: artifactKindsFromEvents(subtaskEvents),
      startedAt,
      finishedAt,
      durationMs: numberDetail(terminal?.detail, "durationMs") ?? elapsedMs(startedAt, finishedAt),
      reason: terminal?.kind === "blocked" ? terminal.summary.replace(/^blocked:\s*/i, "") : null,
      events: subtaskEvents,
    };
  }).sort((a, b) => {
    const phase = a.input.phase - b.input.phase;
    if (phase !== 0) return phase;
    return a.subtaskId.localeCompare(b.subtaskId);
  });

  const counts = timelineCounts(subtasks);
  const startedAt = subtasks.map((subtask) => subtask.startedAt).filter((value): value is string => !!value).sort()[0] ?? null;
  const unfinished = subtasks.some((subtask) => subtask.state === "queued" || subtask.state === "running");
  const finishedAt = unfinished
    ? null
    : subtasks.map((subtask) => subtask.finishedAt).filter((value): value is string => !!value).sort().at(-1) ?? null;
  const state: TeamTimelineState =
    counts.failed > 0 ? "failed" :
    counts.skipped > 0 ? "skipped" :
    counts.running > 0 ? "running" :
    counts.queued > 0 ? "queued" :
    "done";
  const nowMs = opts.nowMs ?? Date.now();
  const stuckAfterMs = opts.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
  const alerts = subtasks.flatMap<TeamRunTimelineAlert>((subtask) => {
    if (subtask.state !== "failed" && subtask.state !== "skipped") return [];
    const finished = isoMs(subtask.finishedAt);
    if (finished === null || nowMs - finished < stuckAfterMs) return [];
    return [{
      kind: "dead_run",
      subtaskId: subtask.subtaskId,
      state: subtask.state,
      reason: subtask.reason ?? "run is blocked without a recorded reason",
      blockedForMs: nowMs - finished,
      pageOwner: true,
    }];
  });

  return {
    teamRunId,
    state,
    startedAt,
    finishedAt,
    durationMs: elapsedMs(startedAt, finishedAt),
    subtaskCount: subtasks.length,
    counts,
    subtasks,
    alerts,
  };
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
    const visibilityDegradedByIndex = new Array<boolean>(input.subtasks.length).fill(false);

    const body = async (ctx: TeamSpanContext): Promise<{ completed: number; failed: number }> => {
      const entries = input.subtasks
        .map((subtask, index) => ({
          subtask,
          index,
          phase: normalizePhase(subtask.phase),
        }))
        .sort((a, b) => (a.phase === b.phase ? a.index - b.index : a.phase - b.phase));
      for (const entry of entries) {
        const delivered = await this.announce(input, entry.subtask, "queued", "queued: " + subtaskLaneSummary(entry.subtask.task), {
          input: inputDetailForTimeline(entry.subtask),
        });
        visibilityDegradedByIndex[entry.index] = !delivered;
      }
      const phases = [...new Set(entries.map((entry) => entry.phase))];
      for (const phase of phases) {
        const phaseEntries = entries.filter((entry) => entry.phase === phase);
        let next = 0;
        const worker = async (): Promise<void> => {
          for (;;) {
            const entry = phaseEntries[next++];
            if (!entry) return;
            const result = await this.runSubtask(input, entry.subtask, ctx.parentSpanId);
            results[entry.index] = {
              ...result,
              visibilityDegraded: visibilityDegradedByIndex[entry.index] || result.visibilityDegraded,
            };
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

  async timeline(
    channelId: string,
    teamRunId: string,
    opts?: { stuckAfterMs?: number; nowMs?: number },
  ): Promise<TeamRunTimeline> {
    const events = await this.readEvents(channelId, { limit: 500 });
    return buildTeamRunTimeline(teamRunId, events, opts);
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
    const maxAttempts = safeSubtaskAttempts(subtask);
    const timeoutMs = safeSubtaskTimeoutMs(subtask);
    if (!prepared.ok) {
      const delivered = await this.announce(input, subtask, "blocked", prepared.error, {
        attempt: 0,
        maxAttempts,
        error: prepared.error,
      });
      return {
        subtaskId: subtask.subtaskId,
        sessionId: null,
        ok: false,
        attempts: 0,
        durationMs: null,
        error: prepared.error,
        visibilityDegraded: !delivered,
      };
    }
    let lastSessionId: string | null = null;
    let lastError: string | null = null;
    let totalDurationMs = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const startedMs = Date.now();
      let sessionId: string | null = null;
      let delivered = await this.announce(input, subtask, "started", "started: " + lane, {
        attempt,
        maxAttempts,
        timeoutMs,
      });
      visibilityDegraded = visibilityDegraded || !delivered;
      try {
        const launched = await this.withTimeout(
          this.deps.launcher.launch({
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            agentMemberId: subtask.agentMemberId,
            createdByMemberId: input.createdByMemberId,
            task: prepared.task,
            harness: subtask.preferredHarness,
            teamRunId: input.teamRunId,
            parentSpanId,
          }),
          timeoutMs,
        );
        sessionId = launched.id;
        lastSessionId = sessionId;
        const remainingTimeoutMs = timeoutMs === null ? null : Math.max(1, timeoutMs - (Date.now() - startedMs));
        await this.withTimeout(this.deps.launcher.join(sessionId), remainingTimeoutMs);
        const missingProducedArtifacts = await this.missingProducedArtifacts(input, subtask);
        if (missingProducedArtifacts.length > 0) {
          throw new Error(
            "blocked: missing produced artifact: " + missingProducedArtifacts.map(artifactLabel).join(", "),
          );
        }
        const durationMs = Date.now() - startedMs;
        totalDurationMs += durationMs;
        delivered = await this.announce(input, subtask, "done", "done: " + lane, {
          attempt,
          maxAttempts,
          sessionId,
          durationMs,
          producedArtifacts: uniqueArtifactKinds(subtask.producesArtifacts),
        });
        visibilityDegraded = visibilityDegraded || !delivered;
        return {
          subtaskId: subtask.subtaskId,
          sessionId,
          ok: true,
          attempts: attempt,
          durationMs: totalDurationMs,
          visibilityDegraded,
        };
      } catch (err) {
        const durationMs = Date.now() - startedMs;
        totalDurationMs += durationMs;
        const error = err instanceof Error ? err.message : String(err);
        lastError = error;
        this.deps.logger.error({ err: error, subtaskId: subtask.subtaskId, attempt }, "team subtask failed");
        if (/timed out after/i.test(error) && sessionId && this.deps.launcher.cancel) {
          await this.deps.launcher.cancel(sessionId).catch((cancelErr) => {
            this.deps.logger.warn(
              { err: cancelErr instanceof Error ? cancelErr.message : String(cancelErr), subtaskId: subtask.subtaskId },
              "team subtask timeout cancel failed",
            );
          });
        }
        if (attempt < maxAttempts) {
          delivered = await this.announce(input, subtask, "milestone", "retrying: " + lane + " after " + error, {
            attempt,
            maxAttempts,
            sessionId,
            durationMs,
            error,
            nextAttempt: attempt + 1,
          });
          visibilityDegraded = visibilityDegraded || !delivered;
          continue;
        }
        const blockedSummary = blockSummary(error);
        delivered = await this.announce(input, subtask, "blocked", blockedSummary, {
          attempt,
          maxAttempts,
          sessionId,
          durationMs,
          error,
          final: true,
        });
        visibilityDegraded = visibilityDegraded || !delivered;
      }
    }
    return {
      subtaskId: subtask.subtaskId,
      sessionId: lastSessionId,
      ok: false,
      attempts: maxAttempts,
      durationMs: totalDurationMs,
      error: lastError ?? "unknown subtask failure",
      visibilityDegraded,
    };
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number | null): Promise<T> {
    if (!timeoutMs) {
      return work;
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("timed out after " + timeoutMs + "ms"));
      }, timeoutMs);
      work.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
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
    detail?: Record<string, unknown>,
  ): Promise<boolean> {
    const event: TeamEvent = {
      teamRunId: input.teamRunId,
      subtaskId: subtask.subtaskId,
      agentMemberId: subtask.agentMemberId,
      kind,
      summary,
      branch: subtask.branch,
      ...(detail ? { detail } : {}),
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
