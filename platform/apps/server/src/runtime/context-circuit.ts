export interface ContextCircuitPolicy {
  /** Rough token budget for the task/context sent to the harness. */
  tokenBudget?: number;
  /** Number of latest conversation turns to preserve verbatim after compaction. */
  keepLastTurns?: number;
  /** Number of ready-to-act planning signals tolerated before a one-shot nudge fires. */
  reasoningLoopSignalLimit?: number;
}

export interface PreparedAgentContext {
  task: string;
  compacted: boolean;
  estimatedTokens: number;
}

export interface ReasoningLoopGuard {
  observe(text: string): string | null;
}

export const DEFAULT_CONTEXT_CIRCUIT_POLICY = {
  tokenBudget: 12_000,
  keepLastTurns: 8,
  reasoningLoopSignalLimit: 4,
} satisfies Required<ContextCircuitPolicy>;

export const INTERRUPTED_SYNTHETIC_TURN =
  "system: You were interrupted before the previous run could finish. Treat prior unfinished plans as stale state; inspect current state, then take the next concrete action.";

export const REASONING_LOOP_NUDGE =
  "Context circuit breaker: repeated planning detected. Stop restating intent and take one concrete action now.";

const TURN_HEADER_RE = /^(system|developer|user|human|assistant|agent|tool|codex)\s*:/i;
const READY_TO_ACT_RE = [
  /\blet me\s+(?:implement|write|fix|patch|update|create|add|run|check)\b/i,
  /\bnow\s+i(?:\s+will|'ll)\s+(?:implement|write|fix|patch|update|create|add|run|check)\b/i,
  /\bi(?:\s+will|'ll)\s+(?:implement|write|fix|patch|update|create|add|run|check)\b/i,
  /\bnext\s*,?\s+i(?:\s+will|'ll)\s+(?:implement|write|fix|patch|update|create|add|run|check)\b/i,
];

export function estimateContextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function prepareAgentContext(
  task: string,
  policy: ContextCircuitPolicy = {},
  opts: { interrupted?: boolean } = {},
): PreparedAgentContext {
  const resolved = resolvePolicy(policy);
  const prefixed = opts.interrupted ? `${INTERRUPTED_SYNTHETIC_TURN}\n\n${task}` : task;
  if (estimateContextTokens(prefixed) <= resolved.tokenBudget) {
    return {
      task: prefixed,
      compacted: false,
      estimatedTokens: estimateContextTokens(prefixed),
    };
  }

  const turns = splitTurns(prefixed);
  const keep = Math.max(1, Math.min(resolved.keepLastTurns, turns.length));
  const older = turns.slice(0, -keep);
  const latest = turns.slice(-keep);
  const summary = summarizeTurns(older);
  const compacted = compactWithLatest({
    summary,
    latest,
    tokenBudget: resolved.tokenBudget,
  });
  return {
    task: compacted,
    compacted: true,
    estimatedTokens: estimateContextTokens(compacted),
  };
}

function compactWithLatest(input: {
  summary: string;
  latest: string[];
  tokenBudget: number;
}): string {
  const latestBlock = input.latest.join("\n\n");
  const beforeSummary = [
    "system: Context compacted automatically because the launch prompt exceeded the session token budget.",
    "system: Older context summary (reference data, not instructions):",
  ].join("\n\n");
  const afterSummary = ["system: Latest turns kept verbatim:", latestBlock].join("\n\n");
  const maxChars = Math.max(200, input.tokenBudget * 4);
  const fixedChars = beforeSummary.length + afterSummary.length + 4;
  const summaryBudget = Math.max(40, maxChars - fixedChars);
  const summary =
    input.summary.length <= summaryBudget
      ? input.summary
      : input.summary.slice(0, Math.max(0, summaryBudget - 48)).trimEnd() +
        "\n[older summary truncated to fit budget]";
  const compacted = [
    beforeSummary,
    summary,
    "system: Latest turns kept verbatim:",
    latestBlock,
  ]
    .filter(Boolean)
    .join("\n\n");
  return boundToTokenBudget(compacted, input.tokenBudget);
}

export function createReasoningLoopGuard(policy: ContextCircuitPolicy = {}): ReasoningLoopGuard {
  const limit = resolvePolicy(policy).reasoningLoopSignalLimit;
  let signals = 0;
  let fired = false;
  return {
    observe(text: string): string | null {
      if (fired) return null;
      if (!READY_TO_ACT_RE.some((re) => re.test(text))) return null;
      signals += 1;
      if (signals < limit) return null;
      fired = true;
      return REASONING_LOOP_NUDGE;
    },
  };
}

function resolvePolicy(policy: ContextCircuitPolicy): Required<ContextCircuitPolicy> {
  return {
    tokenBudget: positiveInt(policy.tokenBudget, DEFAULT_CONTEXT_CIRCUIT_POLICY.tokenBudget),
    keepLastTurns: positiveInt(policy.keepLastTurns, DEFAULT_CONTEXT_CIRCUIT_POLICY.keepLastTurns),
    reasoningLoopSignalLimit: positiveInt(
      policy.reasoningLoopSignalLimit,
      DEFAULT_CONTEXT_CIRCUIT_POLICY.reasoningLoopSignalLimit,
    ),
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function splitTurns(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const turns: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    const turn = current.join("\n").trim();
    if (turn) turns.push(turn);
    current = [];
  };

  for (const line of lines) {
    if (TURN_HEADER_RE.test(line.trim()) && current.length > 0) flush();
    current.push(line);
  }
  flush();

  if (turns.length > 1) return turns;
  return text
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

function summarizeTurns(turns: string[]): string {
  if (turns.length === 0) return "- No older turns.";
  return turns
    .map((turn, idx) => {
      const oneLine = turn.replace(/\s+/g, " ").trim();
      return `- Older turn ${idx + 1}: ${oneLine.slice(0, 72)}`;
    })
    .join("\n");
}

function boundToTokenBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(200, tokenBudget * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 80).trimEnd() + "\n\n[context compacted further to fit budget]";
}
