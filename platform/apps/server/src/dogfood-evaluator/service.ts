import { redactSecrets } from "../runtime/redact.js";
import { redactTracePayload } from "../trace/redact.js";
import type {
  DogfoodEvaluatorConfig,
  DogfoodEvaluationRecord,
  DogfoodFailureKind,
  DogfoodIssueDraft,
  DogfoodIssuePublisher,
  DogfoodLane,
  DogfoodObservedFailure,
  DogfoodRunArtifact,
  DogfoodRunInput,
  DogfoodRunReceipt,
  ExistingIssueSummary,
  MarketingLeverageKind,
} from "./types.js";

const DEFAULT_LABELS = ["dogfood", "ipop-growth", "needs-review"];

const LEVERAGE_KEYWORDS: Array<[MarketingLeverageKind, RegExp]> = [
  ["seo", /\b(seo|search console|keyword|serp|meta title|canonical|schema|sitemap)\b/i],
  ["content", /\b(blog|article|copy|landing page|case study|newsletter|content)\b/i],
  ["social", /\b(linkedin|twitter|x\.com|reddit|hacker news|social|post)\b/i],
  ["email", /\b(email|gmail|newsletter|sequence|inbox|reply)\b/i],
  ["outreach", /\b(outreach|prospect|lead|customer list|dm|cold)\b/i],
  ["analytics", /\b(analytics|ga4|plausible|funnel|conversion|utm|cohort)\b/i],
  ["ads", /\b(ad|ads|campaign|google ads|meta ads|linkedin ads|creative)\b/i],
  ["site", /\b(site|homepage|pricing|signup|onboarding|route|domain|preview)\b/i],
  ["support", /\b(support|ticket|sla|customer success|faq)\b/i],
];

const PLACEHOLDER_RE = /(?:\b(lorem ipsum|coming soon|todo|placeholder|mock(?:ed)?|awaiting consent|example only|demo only)\b|\.\.\.)/i;
const BROKEN_ROUTE_RE = /\b(404|not found|500|couldn'?t build|could not build|failed repeatedly|broken route)\b/i;
const EXTERNAL_TOOL_RE = /\b(gmail|google|twitter|x|reddit|linkedin|hubspot|stripe|plausible|ga4|search console|openphone|sendgrid|mailchimp|clay|lusha)\b/i;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((token) => token.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(token)),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const token of a) if (b.has(token)) hits++;
  return hits / Math.min(a.size, b.size);
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function redactText(value: string, secrets: readonly string[]): string {
  return redactSecrets(value, secrets);
}

function summarizeTraceLinks(traces: Array<Record<string, unknown>>, secrets: readonly string[]): string[] {
  return traces
    .map((trace) => redactTracePayload(trace, secrets))
    .map((trace) => {
      const url = typeof trace.url === "string" ? trace.url : undefined;
      const id = typeof trace.id === "string" ? trace.id : undefined;
      const runId = typeof trace.runId === "string" ? trace.runId : undefined;
      return url ?? id ?? runId;
    })
    .filter((value): value is string => Boolean(value));
}

function redactArtifact(artifact: DogfoodRunArtifact, secrets: readonly string[]): DogfoodRunArtifact {
  return {
    ...artifact,
    title: redactText(artifact.title, secrets),
    content: artifact.content ? redactText(artifact.content, secrets) : undefined,
  };
}

function redactReceipt(receipt: DogfoodRunReceipt, secrets: readonly string[]): DogfoodRunReceipt {
  return {
    ...receipt,
    summary: receipt.summary ? redactText(receipt.summary, secrets) : undefined,
    ref: receipt.ref ? redactText(receipt.ref, secrets) : undefined,
  };
}

function collectCorpus(run: DogfoodRunInput): string {
  return [
    run.task,
    run.goal,
    ...(run.tools ?? []).flatMap((tool) => [tool.name, asText(tool.input), asText(tool.output)]),
    ...(run.artifacts ?? []).flatMap((artifact) => [artifact.kind, artifact.title, artifact.url, artifact.content]),
    ...(run.receipts ?? []).flatMap((receipt) => [receipt.kind, receipt.url, receipt.ref, receipt.summary]),
    ...(run.publicOutputs ?? []).flatMap((output) => [output.surface, output.url, output.content]),
  ]
    .filter(Boolean)
    .join("\n");
}

function classifyLeverage(corpus: string): MarketingLeverageKind[] {
  const found = new Set<MarketingLeverageKind>();
  for (const [kind, pattern] of LEVERAGE_KEYWORDS) {
    if (pattern.test(corpus)) found.add(kind);
  }
  return [...found];
}

function evidenceLine(label: string, value?: string): string[] {
  return value && value.trim() ? [`${label}: ${value.trim()}`] : [];
}

function observeFailures(
  run: DogfoodRunInput,
  corpus: string,
  leverage: MarketingLeverageKind[],
): DogfoodObservedFailure[] {
  const failures: DogfoodObservedFailure[] = [];
  const artifacts = run.artifacts ?? [];
  const receipts = run.receipts ?? [];
  const tools = run.tools ?? [];
  const publicOutputs = run.publicOutputs ?? [];

  const add = (kind: DogfoodFailureKind, summary: string, evidence: string[]) => {
    failures.push({ kind, summary, evidence: evidence.filter(Boolean) });
  };

  if (artifacts.length === 0) {
    add("no_deliverable", "Agent run completed without a concrete deliverable artifact.", [
      `task: ${run.task}`,
      `agents: ${run.agents.join(", ") || "(none recorded)"}`,
    ]);
  }

  if (receipts.length === 0) {
    add("no_receipt", "Agent run has no receipt, trace, URL, or artifact link proving what happened.", [
      `run: ${run.id}`,
    ]);
  }

  if (leverage.length === 0) {
    add("no_marketing_leverage", "Run output does not create observable SEO, content, social, email, outreach, analytics, ads, site, or support leverage.", [
      `task: ${run.task}`,
    ]);
  }

  if (PLACEHOLDER_RE.test(corpus)) {
    add("placeholder_output", "Run output contains placeholder/demo language instead of production marketing work.", [
      ...evidenceLine("matched output", corpus.match(PLACEHOLDER_RE)?.[0]),
      ...publicOutputs.slice(0, 2).map((output) => `${output.surface}: ${output.url ?? output.content ?? "(no content)"}`),
    ]);
  }

  if (BROKEN_ROUTE_RE.test(corpus)) {
    add("broken_route", "Run encountered a broken route or failed generation path while trying to complete the marketing task.", [
      ...evidenceLine("matched output", corpus.match(BROKEN_ROUTE_RE)?.[0]),
    ]);
  }

  const requestedExternalChannel = EXTERNAL_TOOL_RE.test([run.task, run.goal].filter(Boolean).join(" "));
  const usedExternalChannel = tools.some((tool) => EXTERNAL_TOOL_RE.test(tool.name));
  if (requestedExternalChannel && !usedExternalChannel) {
    add("missing_external_channel", "Task asked for an external marketing channel, but no corresponding real integration/tool use was recorded.", [
      `tools used: ${tools.map((tool) => tool.name).join(", ") || "(none recorded)"}`,
    ]);
  }

  return failures;
}

function findExistingIssue(
  run: DogfoodRunInput,
  failures: DogfoodObservedFailure[],
  existingIssues: ExistingIssueSummary[],
): ExistingIssueSummary | undefined {
  const tags = failures.map((failure) => failure.kind.replace(/_/g, " ")).join(" ");
  const queryTokens = tokenize(`${run.task} ${run.goal ?? ""} ${tags}`);
  const runText = normalize(`${run.task} ${run.goal ?? ""} ${tags}`);
  return existingIssues.find((issue) => {
    const issueText = `${issue.title} ${issue.body ?? ""} ${(issue.labels ?? []).join(" ")}`;
    const normalizedIssue = normalize(issueText);
    const issueTokens = tokenize(issueText);
    if (overlapScore(queryTokens, issueTokens) >= 0.32) return true;
    if (failures.some((failure) => normalizedIssue.includes(normalize(failure.kind.replace(/_/g, " "))))) {
      return true;
    }
    const bothExternalChannel =
      /\b(gmail|reddit|linkedin|twitter|outreach|outbound|sender|channel)\b/.test(runText) &&
      /\b(gmail|reddit|linkedin|twitter|outreach|outbound|sender|channel)\b/.test(normalizedIssue);
    return bothExternalChannel && overlapScore(queryTokens, issueTokens) >= 0.18;
  });
}

function fingerprint(run: DogfoodRunInput, failures: DogfoodObservedFailure[]): string {
  const failureKey = failures.map((failure) => failure.kind).sort().join("+") || "pass";
  const taskKey = normalize(run.task).split(" ").slice(0, 8).join("-");
  return `dogfood:${run.lane ?? "ipop-growth"}:${failureKey}:${taskKey}`;
}

function formatList(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- (none recorded)";
}

function buildIssueDraft(
  run: DogfoodRunInput,
  config: DogfoodEvaluatorConfig,
  failures: DogfoodObservedFailure[],
  leverage: MarketingLeverageKind[],
  traceLinks: string[],
  artifacts: DogfoodRunArtifact[],
  receipts: DogfoodRunReceipt[],
): DogfoodIssueDraft | undefined {
  if (failures.length === 0) return undefined;
  const primaryFailure = failures[0]!;
  const fp = fingerprint(run, failures);
  const failureSummary = failures.map((failure) => failure.summary).join(" ");
  const title = `Dogfood gap: ${primaryFailure.kind.replace(/_/g, " ")} in ${run.lane ?? "ipop-growth"} run`;
  const body = [
    `## Observation`,
    `A real ipop agent dogfood run exposed: ${failureSummary}`,
    "",
    `## Run`,
    `- Run: ${run.id}`,
    `- Lane: ${run.lane ?? "ipop-growth"}`,
    `- Task: ${run.task}`,
    run.goal ? `- Goal: ${run.goal}` : undefined,
    `- Agents: ${run.agents.join(", ") || "(none recorded)"}`,
    `- Tools: ${(run.tools ?? []).map((tool) => tool.name).join(", ") || "(none recorded)"}`,
    `- Marketing leverage detected: ${leverage.join(", ") || "(none)"}`,
    "",
    `## Evidence`,
    ...failures.flatMap((failure) => [
      `### ${failure.kind}`,
      failure.summary,
      ...failure.evidence.map((line) => `- ${line}`),
    ]),
    "",
    `## Receipts`,
    formatList([
      ...traceLinks,
      ...artifacts.flatMap((artifact) => [artifact.url, artifact.content ? `${artifact.title}: ${artifact.content.slice(0, 240)}` : undefined]),
      ...receipts.flatMap((receipt) => [receipt.url, receipt.ref, receipt.summary]),
    ].filter((value): value is string => Boolean(value))),
    "",
    `## Expected behavior`,
    "ipop agents working on ipop.ai growth should produce verifiable autonomous marketing leverage with real tool use, receipts, and non-placeholder deliverables. If they cannot proceed, the run should name the blocked capability and route it to operator review.",
    "",
    `## Acceptance criteria`,
    "- Evaluator records task, goal, agents, inputs/tools, deliverable, receipts, observed failure mode, and trace/artifact links for this run.",
    "- The underlying product path produces real marketing leverage or a precise blocked-state receipt instead of a demo/mock success.",
    "- The fix includes a regression fixture for this failure fingerprint.",
    "- Any external send/spend action remains behind the configured policy gate.",
    "",
    `## Dedupe`,
    `Checked ${config.existingIssues.length} open issues before drafting. Fingerprint: \`${fp}\`.`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return {
    title,
    body,
    labels: config.labels ?? DEFAULT_LABELS,
    fingerprint: fp,
  };
}

export function evaluateDogfoodRun(
  run: DogfoodRunInput,
  config: DogfoodEvaluatorConfig,
): DogfoodEvaluationRecord {
  const secrets = run.secretValues ?? [];
  const redactedRun: DogfoodRunInput = {
    ...run,
    task: redactText(run.task, secrets),
    goal: run.goal ? redactText(run.goal, secrets) : undefined,
  };
  const redactedCorpus = redactText(collectCorpus(run), secrets);
  const traceLinks = summarizeTraceLinks(run.traces ?? [], secrets);
  const artifactLinks = (run.artifacts ?? []).map((artifact) => artifact.url).filter((url): url is string => Boolean(url));
  const artifacts = (run.artifacts ?? []).map((artifact) => redactArtifact(artifact, secrets));
  const receipts = (run.receipts ?? []).map((receipt) => redactReceipt(receipt, secrets));
  const leverage = classifyLeverage(redactedCorpus);
  const failures = observeFailures({ ...run, artifacts, receipts }, redactedCorpus, leverage).map((failure) => ({
    ...failure,
    evidence: failure.evidence.map((line) => redactText(line, secrets)),
  }));
  const existingIssue = findExistingIssue(redactedRun, failures, config.existingIssues);
  const issueDraft = existingIssue
    ? undefined
    : buildIssueDraft(redactedRun, config, failures, leverage, traceLinks, artifacts, receipts);

  return {
    runId: run.id,
    lane: run.lane ?? "ipop-growth",
    task: redactedRun.task,
    goal: redactedRun.goal,
    agents: run.agents,
    toolsUsed: (run.tools ?? []).map((tool) => tool.name),
    deliverables: artifacts,
    approvals: run.approvals ?? [],
    receipts,
    marketingLeverage: leverage,
    failures,
    traceLinks,
    artifactLinks,
    existingIssue,
    issueDraft,
  };
}

export async function processDogfoodRun(
  run: DogfoodRunInput,
  config: DogfoodEvaluatorConfig,
  publisher?: DogfoodIssuePublisher,
): Promise<DogfoodEvaluationRecord> {
  const evaluation = evaluateDogfoodRun(run, config);
  if (
    evaluation.issueDraft &&
    config.publishMode === "autopublish" &&
    config.autopublishEnabled === true &&
    publisher
  ) {
    evaluation.publication = await publisher.createIssue(evaluation.issueDraft);
  }
  return evaluation;
}

export function isDogfoodAutopublishArmed(config: DogfoodEvaluatorConfig): boolean {
  return config.publishMode === "autopublish" && config.autopublishEnabled === true;
}

export const DEFAULT_DOGFOOD_LANE: DogfoodLane = "ipop-growth";
