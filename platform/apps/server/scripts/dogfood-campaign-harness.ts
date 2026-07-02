/**
 * Dogfood campaign harness (#dogfood-harness).
 *
 * THE MISSION: use ipop itself to run the most complex marketing campaign it can, score every asset against an
 * award bar, and turn every shortfall into a filed gap. This script is the repeatable end-to-end run against
 * the DEPLOYED ipop.ai:
 *
 *   1. Probe the live API (`GET /readyz`, `GET /version`) — is the target actually up and current?
 *   2. Submit the one complex brief (ipop launching itself) via `PUT /workspaces/:wid/campaign-brief` when a
 *      human auth token is provided; otherwise record the submit as BLOCKED (write is human-auth by design).
 *   3. Ask the fleet to generate the full campaign — currently BLOCKED on prod (agent spawning is down); the
 *      harness records the blocker instead of faking output.
 *   4. Score whatever assets it has (the demonstration set while fleet generation is blocked) against the
 *      award rubric — coverage, spec, voice, numeric dimensions, bar.
 *   5. Emit a scored-campaign artifact + a gap report (operational blockers + per-asset gaps), and print
 *      dedup'd GitHub-issue drafts.
 *
 * GUARDRAIL: this harness NEVER sends anything external on its own. It does not create issues, it does not
 * spend, it does not publish. It writes local files and prints drafts. Filing the gaps as issues is a
 * separate, human-gated step (the operator runs `gh issue create` on the drafts). Nothing here widens scope
 * or reaches a send/spend path — every such action stays behind the #13 approval gate elsewhere in the system.
 *
 * Usage:
 *   npx tsx scripts/dogfood-campaign-harness.ts
 *   IPOP_AUTH_TOKEN=$(...) IPOP_WORKSPACE_ID=<wid> npx tsx scripts/dogfood-campaign-harness.ts
 *   DOGFOOD_OUT=/tmp/run npx tsx scripts/dogfood-campaign-harness.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEMO_CAMPAIGN_ASSETS,
  IPOP_LAUNCH_BRIEF,
  deriveGapDrafts,
  renderScoredCampaign,
  scoreCampaign,
  type GapDraft,
} from "../src/campaign-rubric/index.js";

const API = (process.env.IPOP_API_URL ?? "https://api.ipop.ai").replace(/\/$/, "");
const TOKEN = process.env.IPOP_AUTH_TOKEN;
const WORKSPACE = process.env.IPOP_WORKSPACE_ID;
const OUT_DIR = process.env.DOGFOOD_OUT ?? join(process.cwd(), ".artifacts", "dogfood");

type ProbeStatus = "ok" | "blocked" | "skipped";
interface Probe {
  step: string;
  status: ProbeStatus;
  detail: string;
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { status: res.status, body: (await res.text()).slice(0, 2000) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHealth(): Promise<Probe> {
  try {
    const { status, body } = await fetchJson(`${API}/readyz`);
    if (status === 200 && body.includes("ready")) return { step: "api-health", status: "ok", detail: `${API}/readyz → ${body}` };
    return { step: "api-health", status: "blocked", detail: `${API}/readyz → HTTP ${status} ${body}` };
  } catch (e) {
    return { step: "api-health", status: "blocked", detail: `${API}/readyz threw: ${(e as Error).message}` };
  }
}

async function probeVersion(): Promise<Probe> {
  try {
    const { status, body } = await fetchJson(`${API}/version`);
    if (status === 200) return { step: "api-version", status: "ok", detail: `${API}/version → ${body}` };
    return { step: "api-version", status: "blocked", detail: `${API}/version → HTTP ${status} (deploy may predate the /version endpoint)` };
  } catch (e) {
    return { step: "api-version", status: "blocked", detail: `${API}/version threw: ${(e as Error).message}` };
  }
}

async function submitBrief(): Promise<Probe> {
  if (!TOKEN || !WORKSPACE) {
    return {
      step: "submit-brief",
      status: "blocked",
      detail:
        "Brief write is human-auth by design (PUT /workspaces/:wid/campaign-brief). Provide IPOP_AUTH_TOKEN + IPOP_WORKSPACE_ID to submit. Not available to the harness in this run.",
    };
  }
  try {
    const { status, body } = await fetchJson(`${API}/workspaces/${WORKSPACE}/campaign-brief`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(IPOP_LAUNCH_BRIEF),
    });
    if (status === 200) return { step: "submit-brief", status: "ok", detail: `Brief submitted; server returned rev — ${body}` };
    return { step: "submit-brief", status: "blocked", detail: `PUT campaign-brief → HTTP ${status} ${body}` };
  } catch (e) {
    return { step: "submit-brief", status: "blocked", detail: `PUT campaign-brief threw: ${(e as Error).message}` };
  }
}

function triggerFleetRun(): Probe {
  // Agent spawning is down on prod (runtime switch in flight elsewhere). We do NOT fake fleet output.
  return {
    step: "fleet-generate",
    status: "blocked",
    detail:
      "Fleet asset generation is blocked: agent spawning is currently disabled on prod. No live campaign assets were produced by the fleet in this run. Scoring proceeds against the labelled demonstration asset set so the rubric and gap report are exercised; the scored artifact is NOT fleet output.",
  };
}

function operationalGaps(probes: Probe[], fullyGraded: boolean): GapDraft[] {
  const drafts: GapDraft[] = [];
  const blocked = probes.filter((p) => p.status === "blocked");
  const fleet = blocked.find((p) => p.step === "fleet-generate");
  if (fleet) {
    drafts.push({
      title: "Dogfood blocker: fleet cannot generate campaign assets on prod (agent spawning down)",
      body: [
        "## Observation",
        "The dogfood campaign harness cannot get the fleet to generate any campaign assets on the deployed ipop.ai: agent spawning is disabled on prod.",
        "",
        "## Evidence",
        `- ${fleet.detail}`,
        "",
        "## Impact",
        "The end-to-end dogfood run (brief → fleet-generated integrated campaign → Lens grade → iterate) cannot complete. Only the rubric/scoring half of the harness runs.",
        "",
        "## Acceptance",
        "- Agent spawning is restored on prod and the harness scores REAL fleet output.",
        "- The harness run records live trace/artifact links proving fleet generation, not demonstration inputs.",
      ].join("\n"),
      labels: ["dogfood", "gap", "blocked"],
      fingerprint: "dogfood-campaign:blocker:agent-spawning-prod",
    });
  }
  if (!fullyGraded) {
    drafts.push({
      title: "Dogfood gap: no Lens grader wired for the campaign rubric",
      body: [
        "## Observation",
        "The award rubric supports a Lens/human subjective overlay (insight, craft, channel-nativeness, coherence), but the harness has no API to obtain a Lens grade, so every asset is scored objective-only and cannot be certified award-ready.",
        "",
        "## Acceptance",
        "- Lens grades assets against the rubric dimensions via a callable path the harness can invoke.",
        "- A graded run can reach an 'award-ready' verdict when assets clear the bar.",
      ].join("\n"),
      labels: ["dogfood", "campaign-rubric", "gap"],
      fingerprint: "dogfood-campaign:gap:no-lens-grader",
    });
  }
  const brief = blocked.find((p) => p.step === "submit-brief");
  if (brief) {
    drafts.push({
      title: "Dogfood gap: harness cannot submit the brief without a human auth token",
      body: [
        "## Observation",
        "Submitting the campaign brief to the deployed fleet requires human auth (PUT /workspaces/:wid/campaign-brief). The harness has no scoped token, so it cannot seed the brief programmatically to kick off a run.",
        "",
        "## Evidence",
        `- ${brief.detail}`,
        "",
        "## Acceptance",
        "- A scoped, owner-approved harness credential (or an existing seeded brief) lets the repeatable run submit the brief without a human in the loop for the read/seed step.",
        "- Any send/spend still stays behind the #13 approval gate.",
      ].join("\n"),
      labels: ["dogfood", "gap"],
      fingerprint: "dogfood-campaign:gap:harness-brief-auth",
    });
  }
  return drafts;
}

function renderGapReport(runId: string, probes: Probe[], drafts: GapDraft[]): string {
  const lines: string[] = [];
  lines.push(`# Dogfood campaign gap report`);
  lines.push(`Run: \`${runId}\` · target: ${API}`);
  lines.push("");
  lines.push(`## Live API probes`);
  for (const p of probes) lines.push(`- [${p.status.toUpperCase()}] **${p.step}** — ${p.detail}`);
  lines.push("");
  lines.push(`## Gaps to file (${drafts.length})`);
  for (const d of drafts) {
    lines.push(`### ${d.title}`);
    lines.push(`Labels: ${d.labels.join(", ")} · fingerprint: \`${d.fingerprint}\``);
    lines.push("");
    lines.push(d.body);
    lines.push("");
    lines.push("---");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const runId = `dogfood-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`[dogfood-harness] run ${runId} → ${API}`);

  const probes: Probe[] = [];
  probes.push(await probeHealth());
  probes.push(await probeVersion());
  probes.push(await submitBrief());
  probes.push(triggerFleetRun());
  for (const p of probes) console.log(`  [${p.status}] ${p.step}: ${p.detail.slice(0, 120)}`);

  // Score the assets we have. While fleet generation is blocked, these are labelled demonstration inputs.
  const provenance = "demonstration (hand-authored) — fleet generation blocked (agent spawning down on prod)";
  const scored = scoreCampaign(IPOP_LAUNCH_BRIEF, DEMO_CAMPAIGN_ASSETS);
  const artifact = renderScoredCampaign(scored, { runId, provenance });

  const gapDrafts = [...operationalGaps(probes, scored.fullyGraded), ...deriveGapDrafts(scored, runId)];
  const gapReport = renderGapReport(runId, probes, gapDrafts);

  const dir = join(OUT_DIR, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scored-campaign.md"), artifact);
  writeFileSync(join(dir, "gap-report.md"), gapReport);
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ runId, api: API, provenance, probes, verdict: scored.verdict, overall: scored.overall, gapCount: gapDrafts.length, gaps: gapDrafts }, null, 2),
  );

  console.log("");
  console.log(`[dogfood-harness] verdict: ${scored.verdict.toUpperCase()} · overall ${scored.overall}/${scored.bar}`);
  console.log(`[dogfood-harness] ${gapDrafts.length} gap(s) to file:`);
  for (const d of gapDrafts) console.log(`  - ${d.title}`);
  console.log("");
  console.log(`[dogfood-harness] wrote ${join(dir, "scored-campaign.md")}`);
  console.log(`[dogfood-harness] wrote ${join(dir, "gap-report.md")}`);
  console.log(`[dogfood-harness] REVIEW MODE — no issues filed, nothing sent. File drafts with: gh issue create ...`);
}

main().catch((e) => {
  console.error("[dogfood-harness] fatal:", e);
  process.exit(1);
});
