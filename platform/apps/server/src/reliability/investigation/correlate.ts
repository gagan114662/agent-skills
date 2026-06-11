/**
 * Pure AI-investigation correlator for the reliability surface (#148, ADR-0148). On incident open the
 * IO coordinator gathers recent deploys (#73), failure fingerprints (#117), and the latest saturation
 * sample (#113); this module ranks them into *likely causes + suggested next steps*. It is **advisory
 * only** — it never acts. Remediation still flows through the flywheel → issue → agent path with #13
 * gates intact (that contract is rendered into the note). No IO, no clock: every input is supplied, so
 * each correlation rule is a unit test.
 */

export type Confidence = "high" | "medium" | "low";
export type CauseKind = "recent_deploy" | "resource_saturation" | "recurring_failure";

export interface DeploySignal {
  id: string;
  target: string;
  status: string;
  at: Date;
}

export interface FingerprintSignal {
  signature: string;
  failureClass: string;
  occurrenceCount: number;
  status: string;
}

export interface SaturationSignal {
  status: "ok" | "warn" | "critical";
  resource?: string;
  value?: number;
}

export interface CorrelateInput {
  incident: {
    service: string;
    sloKind: string;
    severity: "warning" | "critical";
    observedValue: number;
    targetValue: number;
    openedAt: Date;
  };
  recentDeploys: DeploySignal[];
  fingerprints: FingerprintSignal[];
  saturation: SaturationSignal | null;
  /** How far before `openedAt` a deploy still counts as a suspect (e.g. 30 min). */
  deployWindowMs: number;
}

export interface LikelyCause {
  kind: CauseKind;
  confidence: Confidence;
  detail: string;
  suggestedNextStep: string;
}

export interface InvestigationNote {
  summary: string;
  likelyCauses: LikelyCause[];
  nextSteps: string[];
  correlatedSignals: { deploys: number; fingerprints: number; saturation: string };
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** The standing advisory every investigation closes with — remediation is never automatic. */
const ADVISORY_STEP =
  "All suggestions are advisory — any remediation flows through the flywheel → issue → agent path with #13 approval gates intact.";

function deployCause(input: CorrelateInput): LikelyCause | null {
  const openedMs = input.incident.openedAt.getTime();
  // Suspects = deploys at/after (openedAt − window) and at/before openedAt, newest first.
  const suspects = input.recentDeploys
    .filter((d) => {
      const dt = d.at.getTime();
      return dt <= openedMs && openedMs - dt <= input.deployWindowMs;
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const top = suspects[0];
  if (!top) return null;
  const ageMs = openedMs - top.at.getTime();
  const confidence: Confidence = ageMs <= 10 * 60_000 ? "high" : "medium";
  return {
    kind: "recent_deploy",
    confidence,
    detail: `Deploy ${top.id} to ${top.target} (${top.status}) landed ${Math.round(ageMs / 60_000)} min before the breach.`,
    suggestedNextStep: `Review or roll back deploy ${top.id} (#73 deploy history) — rollback is gated, not automatic.`,
  };
}

function saturationCause(input: CorrelateInput): LikelyCause | null {
  const sat = input.saturation;
  if (!sat || sat.status === "ok") return null;
  const resource = sat.resource ?? "a resource";
  return {
    kind: "resource_saturation",
    confidence: sat.status === "critical" ? "high" : "low",
    detail: `Saturation is ${sat.status} on ${resource}${sat.value !== undefined ? ` (${sat.value})` : ""}.`,
    suggestedNextStep: `Investigate ${resource} saturation — review the #71 admission caps / scale the resource.`,
  };
}

function fingerprintCauses(input: CorrelateInput): LikelyCause[] {
  return input.fingerprints
    .filter((f) => f.status !== "resolved" && f.occurrenceCount >= 2)
    .map((f) => {
      const confidence: Confidence =
        f.occurrenceCount >= 10 ? "high" : f.occurrenceCount >= 3 ? "medium" : "low";
      return {
        kind: "recurring_failure" as const,
        confidence,
        detail: `Recurring failure ${f.signature} (${f.failureClass}) seen ${f.occurrenceCount}×.`,
        suggestedNextStep:
          "Let the self-healing flywheel (#117) file/track the fix issue — fixes ship through the gated agent path.",
      };
    });
}

export function correlateIncident(input: CorrelateInput): InvestigationNote {
  const causes: LikelyCause[] = [];
  const deploy = deployCause(input);
  if (deploy) causes.push(deploy);
  const sat = saturationCause(input);
  if (sat) causes.push(sat);
  causes.push(...fingerprintCauses(input));

  // Stable sort by confidence (high → low); insertion order breaks ties.
  causes.sort((a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence]);

  const top = causes[0];
  const summary = top
    ? top.detail
    : `No correlated signal for ${input.incident.service} ${input.incident.sloKind} — manual triage required.`;

  // Deduped suggested steps (first occurrence wins), then the standing advisory.
  const nextSteps: string[] = [];
  const seen = new Set<string>();
  for (const c of causes) {
    if (!seen.has(c.suggestedNextStep)) {
      seen.add(c.suggestedNextStep);
      nextSteps.push(c.suggestedNextStep);
    }
  }
  if (causes.length === 0) {
    nextSteps.push(
      `Triage ${input.incident.service} manually — no deploy, saturation, or recurring-failure signal correlated.`,
    );
  }
  nextSteps.push(ADVISORY_STEP);

  return {
    summary,
    likelyCauses: causes,
    nextSteps,
    correlatedSignals: {
      deploys: input.recentDeploys.length,
      fingerprints: input.fingerprints.length,
      saturation: input.saturation?.status ?? "none",
    },
  };
}
